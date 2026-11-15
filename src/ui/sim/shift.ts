/**
 * The shift (Phase 5): connects a timetable to the running simulation.
 *
 * It owns no movement and no interlocking. Every step it
 *   - releases a scheduled train at its boundary once SIMULATION time reaches its entry time
 *     (the train then enters only if the signals and the line ahead allow: Phase 4 admission),
 *   - holds a stopping train at the platform until its scheduled departure time (the dwell is never
 *     shortened below the minimum; a late train simply leaves late),
 *   - records actual entry / arrival / departure / pass / exit times from what the trains really did,
 *   - decides when the shift is over: only when every service has completed (or was cancelled or
 *     failed) and no train is left in the area or waiting outside it.
 * Time is `sim.clockS`, advanced only by fixed simulation steps, so pause and the speed multiplier
 * affect everything together.
 */

import {
  SHIFT_START_CLOCK_S,
  STATION_PASS_SECTIONS,
  clockText,
  currentDelayS,
  deriveStatus,
  emptyActual,
  ecsPlanOf,
  terminalPlanOf,
  type TerminalPlan,
  frontSection,
  generateTimetable,
  DEFAULT_DIFFICULTY,
  type DifficultyId,
  validateTimetable,
  createSignallingState,
  isTerminal,
  summarise,
  delaysOf,
  ON_TIME_S,
  type Delays,
  type ServiceActual,
  type ServiceSchedule,
  type ServiceStatus,
  type ShiftSummary,
  type Timetable,
  type Train,
} from '../../engine';
import { EventLog, attachLogging, type LogCategory, type LogEntry } from './eventLog';
import type { ShiftStore } from './storage';
import type { Simulation } from './simulation';

export type ShiftStatus = 'not started' | 'running' | 'completed' | 'abandoned';

export interface Shift {
  readonly id: number;
  readonly timetable: Timetable;
  status: ShiftStatus;
  /** Shift time at which it ended (completed or abandoned). */
  endedS: number | null;
  readonly actuals: Map<string, ServiceActual>;
  summary: ShiftSummary | null;
  /** The log entries of this shift, kept with its record (set when it ends). */
  events: LogEntry[];
}

export interface ServiceRow {
  readonly service: ServiceSchedule;
  readonly actual: ServiceActual;
  readonly status: ServiceStatus;
  readonly delayS: number | null;
  readonly delays: Delays;
  readonly train: Train | null;
}

/**
 * One line of the timetable as shown. An ordinary service has one ('whole'). An ECS siding cycle is ONE physical train and ONE
 * service record (so it is counted once and never creates a second train), but it is shown as two entries generated together
 * with the timetable: the incoming ECS movement and the outgoing service that continues from it.
 */
export type EntryLeg = 'whole' | 'incoming' | 'outgoing';

export interface TimetableEntry {
  /** Unique selection id: the service id, or `<service id>:out` for the outgoing entry. */
  readonly entryId: string;
  readonly leg: EntryLeg;
  readonly headcode: string;
  readonly trainClass: 1 | 2 | 5;
  /** For an outgoing entry: the original ECS headcode it continues ("Outgoing train for 5R69"). */
  readonly forHeadcode: string | null;
  /** For an incoming entry: the headcode it becomes. */
  readonly becomes: string | null;
  readonly siding: string | null;
  /** Shift time the entry is placed at in the chronological order. */
  readonly sortS: number;
  /** Status, delay and times of THIS entry (not of the whole service). */
  readonly status: ServiceStatus;
  readonly delayS: number | null;
  readonly row: ServiceRow;
}

export const outgoingId = (serviceId: string): string => `${serviceId}:out`;
export const serviceIdOf = (entryId: string): string => (entryId.endsWith(':out') ? entryId.slice(0, -4) : entryId);

type MessageFn = (kind: 'ok' | 'error' | 'info' | 'warn', text: string, category: LogCategory) => void;
const PLACE: Record<string, string> = { 'W-IN': 'Westford', 'W-OUT': 'Westford', 'N-IN': 'Northbridge', 'N-OUT': 'Northbridge', 'M-IO': 'Merefield', 'AJ-IN': 'Ashcombe Junction', 'AJ-OUT': 'Ashcombe Junction', 'BR-F-IN': 'Barchester (fast line)', 'BR-S-IN': 'Barchester (slow line)', 'BR-F-OUT': 'Barchester (fast line)', 'BR-S-OUT': 'Barchester (slow line)' };
export const placeName = (boundary: string): string => PLACE[boundary] ?? boundary;

/** Consecutive refusals after which a service that cannot be created is recorded as failed. */
const MAX_CREATE_FAILURES = 20;

export class ShiftController {
  private shiftCounter = 0;
  private seedCounter = 0;
  private listeners = new Set<() => void>();
  private version = 0;
  private reportedLate = new Map<string, number>();
  private createFailures = new Map<string, number>();
  private sink: MessageFn = () => {};
  readonly log: EventLog;

  /** Timetable generated but not yet started: it can be inspected first. */
  draft: Timetable | null = null;
  /** The shift being played, or the one that has just ended. */
  current: Shift | null = null;
  /** Earlier shifts (completed or abandoned), newest last. Never discarded when a new shift starts. */
  readonly history: Shift[] = [];
  /** Selected service (timetable row). */
  selectedServiceId: string | null = null;

  /** Display text of a movement id ("AJ01 → AJ02"). */
  routeText(routeId: string): string {
    return this.sim.ctx.routeName(routeId);
  }

  constructor(
    private readonly sim: Simulation,
    private readonly store: ShiftStore | null = null,
    log?: EventLog,
  ) {
    this.log = log ?? new EventLog(() => sim.clockS);
    if (store) {
      this.history.push(...store.load());
      this.shiftCounter = this.history.reduce((m, h) => Math.max(m, h.id), 0);
    }
  }

  /**
   * Connects the controller to the simulation (step processing, event logging, error reporting) and returns
   * the function that disconnects it. Called from an effect, so a re-mount never leaves a second set of listeners.
   */
  attach(): () => void {
    const offStep = this.sim.addStepHook(() => this.afterStep());
    const offLog = attachLogging(this.sim, this.log, () => this.running);
    this.sim.onError = (e) => {
      console.error('Simulation step failed', e); // technical detail for the console only
      this.log.add('system', 'error', 'The simulation hit an internal problem and has been paused. Resume to continue, or abandon the shift. Details are in the browser console.');
    };
    return () => {
      offStep();
      offLog();
      this.sim.onError = null;
    };
  }

  /** Optional extra listener for messages (tests); the event log always receives them. */
  setMessageSink(fn: (kind: 'ok' | 'error' | 'info' | 'warn', text: string) => void): void {
    this.sink = (k, t) => fn(k, t);
  }

  private message(kind: 'ok' | 'error' | 'info' | 'warn', text: string, category: LogCategory = 'timetable'): void {
    this.log.add(category, kind, text);
    this.sink(kind, text, category);
  }

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  readonly getVersion = (): number => this.version;
  private touch(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  get running(): boolean {
    return this.current?.status === 'running';
  }

  /** Shift time now, seconds. */
  get nowS(): number {
    return this.sim.clockS;
  }

  /** The timetable shown: the shift's own while one is running or has just ended, otherwise the draft. */
  get timetable(): Timetable | null {
    return this.current && this.current.status !== 'not started' ? this.current.timetable : this.draft;
  }

  /** Time of day text for a shift time. */
  clock(shiftS: number, seconds = false): string {
    return clockText(this.timetable?.startClockS ?? SHIFT_START_CLOCK_S, shiftS, seconds);
  }

  // --- lifecycle --------------------------------------------------------------------

  /** The difficulty the next generated timetable uses (set by `generate`). */
  difficulty: DifficultyId = DEFAULT_DIFFICULTY;

  /** Generates (or regenerates) the draft timetable for the next shift. Not allowed while a shift is running. */
  generate(seed?: number, difficulty?: DifficultyId): Timetable | null {
    if (this.running) {
      this.message('error', 'A shift is running. Abandon it before generating a new timetable.', 'shift');
      return null;
    }
    const s = seed ?? this.nextSeed();
    if (difficulty) this.difficulty = difficulty;
    this.draft = generateTimetable(this.sim.ctx, s, { difficulty: this.difficulty });
    if (this.current && this.current.status !== 'not started') this.current = null; // an ended shift is already in history
    this.touch();
    return this.draft;
  }

  private nextSeed(): number {
    this.seedCounter++;
    return (Date.now() % 100000) + this.seedCounter;
  }

  /** Starts the shift on the draft timetable (generating one first if there is none). */
  start(): boolean {
    if (this.running) {
      this.message('error', 'A shift is already running.', 'shift');
      return false;
    }
    if (!this.draft) this.generate();
    const timetable = this.draft;
    if (!timetable) {
      this.message('error', 'There is no timetable to start. Generate one first.', 'shift');
      return false;
    }
    const problems = validateTimetable(this.sim.ctx, timetable);
    if (problems.length > 0) {
      console.error('Timetable failed validation', problems);
      this.message('error', 'This timetable failed its safety checks and was not started. Generate a new one.', 'shift');
      this.draft = null;
      this.touch();
      return false;
    }
    this.shiftCounter++;
    // Clean slate: no test trains, routes, locks or occupancy left over; the clock goes back to zero.
    this.log.silent(() => this.sim.resetAll(createSignallingState(this.sim.ctx.net)));
    this.log.shiftId = this.shiftCounter;
    this.sim.clockActive = true;
    this.reportedLate.clear();
    this.createFailures.clear();
    const actuals = new Map<string, ServiceActual>();
    for (const s of timetable.services) actuals.set(s.id, emptyActual());
    this.current = { id: this.shiftCounter, timetable, status: 'running', endedS: null, actuals, summary: null, events: [] };
    this.draft = null;
    this.selectedServiceId = null;
    this.message('ok', `Shift ${this.shiftCounter} started at ${clockText(timetable.startClockS, 0)}: ${timetable.services.length} services timetabled.`, 'shift');
    this.touch();
    return true;
  }

  /** Abandons the shift being played: everything is cleared and the shift is kept in history as abandoned. */
  abandon(): boolean {
    const sh = this.current;
    if (!sh || sh.status !== 'running') return false;
    sh.status = 'abandoned';
    sh.endedS = this.nowS;
    sh.summary = summarise(sh.id, sh.timetable.services, sh.actuals);
    this.message('info', `Shift ${sh.id} abandoned.`, 'shift');
    this.log.silent(() => this.sim.reset());
    this.finishRecord(sh);
    this.touch();
    return true;
  }

  /** An ended shift is kept in history at once (and saved), with the events it produced. */
  private finishRecord(sh: Shift): void {
    sh.events = this.log.forShift(sh.id);
    this.log.shiftId = null;
    if (!this.history.includes(sh)) this.history.push(sh);
    this.store?.save(this.history);
  }

  /** Cancels a service that has not entered the area yet. */
  cancelService(id: string): boolean {
    const sh = this.current;
    if (!sh || sh.status !== 'running') return false;
    const a = sh.actuals.get(id);
    const svc = sh.timetable.services.find((s) => s.id === id);
    if (!a || !svc || isTerminal(a) || a.entryS !== null) return false;
    if (a.trainId !== null) this.sim.remove(a.trainId);
    sh.actuals.set(id, { ...a, trainId: null, cancelledS: this.nowS });
    this.message('info', `${svc.headcode} (${this.clock(svc.entryS)} from ${this.place(svc.origin)}) has been cancelled.`);
    this.touch();
    this.checkCompletion();
    return true;
  }

  select(id: string | null): void {
    this.selectedServiceId = id;
    const sh = this.current;
    const a = id && sh ? sh.actuals.get(serviceIdOf(id)) : null;
    if (a?.trainId) this.sim.select(a.trainId);
    this.touch();
  }

  /** Selecting a train on the diagram or the operations strip selects its timetable row too. */
  selectByTrain(trainId: string): void {
    const sh = this.current;
    if (!sh) return;
    for (const [id, a] of sh.actuals) {
      if (a.trainId === trainId) {
        const svc = sh.timetable.services.find((x) => x.id === id);
        // an ECS train is the incoming entry until it is stabled, and the outgoing service after that
        this.selectedServiceId = svc?.ecs && a.arrivalS !== null ? outgoingId(id) : id;
        this.touch();
        return;
      }
    }
  }

  /** Forgets the saved shift records (the ones in memory and the ones in the browser). */
  clearHistory(): void {
    this.history.length = 0;
    this.store?.save(this.history);
    this.touch();
  }

  // --- per-step processing ------------------------------------------------------------

  private afterStep(): void {
    const sh = this.current;
    if (!sh || sh.status !== 'running') return;
    const now = this.nowS;
    let changed = false;
    for (const svc of sh.timetable.services) {
      let a = sh.actuals.get(svc.id) as ServiceActual;
      if (isTerminal(a)) continue;
      const before = a;

      // 1. release the train at its scheduled entry time
      if (a.trainId === null && now >= svc.entryS) {
        const ecsPlan = svc.ecs ? ecsPlanOf(this.sim.ctx, svc) : undefined;
        const r = svc.ecs?.terminal
          ? this.sim.createTerminalScheduled({ headcode: svc.headcode, trainClass: svc.trainClass as 1 | 2 | 5, model: svc.model, formation: svc.formation, origin: svc.origin, platform: svc.ecs.siding, terminalDwellS: svc.ecs.terminal.dwellS, onward: { headcode: svc.ecs.onward.headcode, trainClass: svc.ecs.onward.trainClass, destination: svc.ecs.onward.destination }, inboundCall: svc.ecs.terminal.inboundCall, outboundCall: svc.ecs.terminal.outboundCall, ...(terminalPlanOf(this.sim.ctx, svc) ? { plan: terminalPlanOf(this.sim.ctx, svc) as TerminalPlan } : {}) })
          : svc.ecs
          ? this.sim.createEcsScheduled({ headcode: svc.headcode, model: svc.model, formation: svc.formation, origin: svc.origin, siding: svc.ecs.siding, onward: { headcode: svc.ecs.onward.headcode, trainClass: svc.ecs.onward.trainClass, destination: svc.ecs.onward.destination }, stablingS: svc.ecs.stablingS, ...(ecsPlan ? { plan: ecsPlan } : {}) })
          : this.sim.createScheduled({ headcode: svc.headcode, trainClass: svc.trainClass, origin: svc.origin, destination: svc.destination, platform: svc.platform, dwellS: svc.minDwellS, planId: svc.planId, model: svc.model, formation: svc.formation });
        if (r.ok) {
          a = { ...a, trainId: r.train.id, createdS: now };
          this.message('info', `${svc.headcode} is ready to enter from ${this.place(svc.origin)}.`, 'train');
        } else {
          const n = (this.createFailures.get(svc.id) ?? 0) + 1;
          this.createFailures.set(svc.id, n);
          if (n >= MAX_CREATE_FAILURES) {
            a = { ...a, failedReason: r.reason };
            this.message('error', `${svc.headcode} could not be started: ${r.reason}`);
          }
        }
      }

      const train = a.trainId ? (this.sim.trains.find((t) => t.id === a.trainId) ?? null) : null;
      if (train) a = this.observe(svc, a, train, now);

      // a service still outside: report lateness once per whole minute
      if (a.trainId !== null && a.entryS === null) this.reportLate(svc, now - svc.entryS, 'waiting to enter');

      if (a !== before) {
        sh.actuals.set(svc.id, a);
        changed = true;
      }
    }
    if (changed) this.touch();
    this.checkCompletion();
  }

  /** Records what the train just did. */
  private observe(svc: ServiceSchedule, a0: ServiceActual, train: Train, now: number): ServiceActual {
    let a = a0;
    const name = svc.headcode;
    // entry: the front has crossed the boundary
    if (a.entryS === null && train.frontM >= 0) {
      a = { ...a, entryS: now };
      const d = now - svc.entryS;
      this.message('info', `${name} entered the controlled area from ${this.place(svc.origin)}${d >= ON_TIME_S ? ` (${Math.round(d / 60)} min late)` : ''}.`, 'train');
      this.reportLate(svc, d, 'entering');
    }
    const stop = train.stop;
    if (svc.ecs?.terminal) {
      // Terminating service (Northbridge): arrive and dwell -> change ends -> depart, from what the train really did.
      const job = train.terminal;
      const term = (this.sim.ctx.net.def.terminals ?? []).find((t) => t.platform === svc.ecs?.siding);
      const net = this.sim.ctx.net;
      const atTerminal = stop !== null && net.def.terminals?.some((t) => t.section === stop.section) === true;
      if (job && a.arrivalS === null && stop && atTerminal && (stop.phase === 'dwelling' || stop.phase === 'done')) {
        a = { ...a, arrivalS: now, actualPlatform: stop.platform };
        const d = svc.arrivalS !== null ? now - svc.arrivalS : 0;
        const planned = stop.platform !== svc.ecs.siding ? ` (planned: ${net.platforms.get(svc.ecs.siding)?.name ?? svc.ecs.siding})` : '';
        this.message('info', `${name} arrived at ${net.platforms.get(stop.platform)?.name ?? stop.platform}${planned}${d >= ON_TIME_S ? ` (${Math.round(d / 60)} min late)` : ''}.`, 'train');
        this.reportLate(svc, d, 'at the terminus');
      }
      if (job && a.arrivalS !== null && a.readyS === null && (job.stage === 'ready' || job.stage === 'leaving' || job.stage === 'done')) a = { ...a, readyS: now };
      if (job && a.readyS !== null && a.departureS === null && (job.stage === 'leaving' || job.stage === 'done')) {
        a = { ...a, departureS: now };
        const d = svc.departureS !== null ? now - svc.departureS : 0;
        this.message('info', `${train.spec.headcode} departed ${term?.name ?? 'the terminus'}${d >= ON_TIME_S ? ` (${Math.round(d / 60)} min late)` : ''}.`, 'train');
        this.reportLate(svc, d, 'departing the terminus');
      }
    } else if (svc.ecs) {
      // ECS siding cycle (Phase 9): stabled -> ready -> left the siding, from what the train really did.
      const job = train.ecs;
      const siding = this.sim.ctx.net.sidings.get(svc.ecs.siding)?.name ?? svc.ecs.siding;
      if (job && a.arrivalS === null && job.stage !== 'inbound') {
        a = { ...a, arrivalS: now };
        const d = svc.arrivalS !== null ? now - svc.arrivalS : 0;
        this.message('info', `${name} is stabled in ${siding}${d >= ON_TIME_S ? ` (${Math.round(d / 60)} min late)` : ''}.`, 'train');
        this.reportLate(svc, d, 'stabling');
      }
      if (job && a.arrivalS !== null && a.readyS === null && (job.stage === 'ready' || job.stage === 'leaving' || job.stage === 'onward')) {
        a = { ...a, readyS: now };
      }
      if (job && a.readyS !== null && a.departureS === null && (job.stage === 'leaving' || job.stage === 'onward')) {
        a = { ...a, departureS: now };
        const d = svc.departureS !== null ? now - svc.departureS : 0;
        this.message('info', `${train.spec.headcode} left ${siding}${d >= ON_TIME_S ? ` (${Math.round(d / 60)} min late)` : ''}.`, 'train');
        this.reportLate(svc, d, 'leaving the siding');
      }
    } else if (svc.stops && stop) {
      // arrival: stopped at the platform. Hold the departure to the timetable.
      if (a.arrivalS === null && (stop.phase === 'dwelling' || stop.phase === 'done')) {
        a = { ...a, arrivalS: now, actualPlatform: stop.platform };
        const plat = this.sim.ctx.net.platforms.get(stop.platform)?.name ?? stop.platform;
        const planned = stop.scheduledPlatform !== stop.platform ? ` (planned: ${this.sim.ctx.net.platforms.get(stop.scheduledPlatform)?.name ?? stop.scheduledPlatform})` : '';
        const dueDwell = Math.max(svc.minDwellS, (svc.departureS ?? now) - now);
        this.sim.updateTrain(train.id, (t) => (t.stop ? { ...t, stop: { ...t.stop, dwellS: dueDwell, remainingS: dueDwell } } : t));
        const d = svc.arrivalS !== null ? now - svc.arrivalS : 0;
        this.message('info', `${name} arrived at ${plat}${planned}${d >= ON_TIME_S ? ` (${Math.round(d / 60)} min late)` : ''}.`, 'train');
        this.reportLate(svc, d, 'at the platform');
      }
      if (a.arrivalS !== null && a.readyS === null && stop.phase === 'done') {
        a = { ...a, readyS: now };
        this.message('info', `${name} is ready to depart${train.status === 'ready to depart' && train.holdReason.startsWith('Signal') ? `; ${train.holdReason}` : ''}.`, 'train');
      }
      if (a.readyS !== null && a.departureS === null && train.speedMs > 0.1) {
        a = { ...a, departureS: now };
        const d = svc.departureS !== null ? now - svc.departureS : 0;
        this.message('info', `${name} departed ${this.sim.ctx.net.platforms.get(stop.platform)?.name ?? stop.platform}${d >= ON_TIME_S ? ` (${Math.round(d / 60)} min late)` : ''}.`, 'train');
        this.reportLate(svc, d, 'departing');
      }
    } else if (a.passS === null && svc.passS !== null && STATION_PASS_SECTIONS.includes(frontSection(train) ?? '')) {
      a = { ...a, passS: now };
      this.message('info', `${name} passed Ashcombe Junction.`, 'train');
    }
    // exit: rear has cleared the boundary
    if (a.exitS === null && train.finished) {
      a = { ...a, exitS: now };
      const d = now - svc.exitS;
      this.message('ok', `${name} has completely left the controlled area at ${this.place(svc.destination)}${d >= ON_TIME_S ? ` (${Math.round(d / 60)} min late)` : ''}.`, 'train');
    }
    return a;
  }

  /** "5Z83 is delayed by 2 minutes." once per whole minute of lateness. */
  private reportLate(svc: ServiceSchedule, delayS: number, where: string): void {
    const minutes = Math.floor(delayS / 60);
    if (minutes < 1) return;
    if ((this.reportedLate.get(svc.id) ?? 0) >= minutes) return;
    this.reportedLate.set(svc.id, minutes);
    this.message('warn', `${svc.headcode} is delayed by ${minutes} minute${minutes === 1 ? '' : 's'} (${where}).`);
  }

  /** The shift is over only when nothing is outstanding, in the area, or waiting to enter. */
  checkCompletion(): void {
    const sh = this.current;
    if (!sh || sh.status !== 'running') return;
    const allDone = sh.timetable.services.every((s) => isTerminal(sh.actuals.get(s.id) as ServiceActual));
    const nothingInArea = this.sim.trains.every((t) => t.finished);
    if (!allDone || !nothingInArea) return;
    sh.status = 'completed';
    sh.endedS = this.nowS;
    sh.summary = summarise(sh.id, sh.timetable.services, sh.actuals);
    this.sim.clockActive = false;
    this.message('ok', `Shift ${sh.id} is complete at ${this.clock(sh.endedS, true)}: every service has finished and the area is clear.`, 'shift');
    this.finishRecord(sh);
    this.touch();
  }

  // --- derived views --------------------------------------------------------------------

  /** Display name of a boundary: the network's own place name, else the Ashcombe table. */
  place(boundary: string): string {
    return this.sim.ctx.net.boundaries.get(boundary)?.location ?? placeName(boundary);
  }

  sidingName(id: string): string {
    return this.sim.ctx.net.sidings.get(id)?.name ?? this.sim.ctx.net.platforms.get(id)?.name ?? id;
  }

  /** The timetable as displayed: every ECS cycle contributes its incoming and outgoing entries, in chronological order. */
  entries(shift: Shift | null = this.current): TimetableEntry[] {
    const live = shift !== null && shift === this.current && shift.status === 'running';
    const now = live ? this.nowS : (shift?.endedS ?? 0);
    const out: TimetableEntry[] = [];
    for (const row of this.rows(shift)) {
      const s = row.service;
      const a = row.actual;
      if (!s.ecs) {
        out.push({ entryId: s.id, leg: 'whole', headcode: s.headcode, trainClass: s.trainClass, forHeadcode: null, becomes: null, siding: null, sortS: s.entryS, status: row.status, delayS: row.delayS, row });
        continue;
      }
      const ended = a.cancelledS !== null || a.failedReason !== null;
      // Incoming ECS: Completed the moment the train is fully stabled (not when it later leaves).
      const inStatus: ServiceStatus = ended ? row.status : a.arrivalS !== null ? 'Completed' : row.status;
      const inDelay = ended ? null : currentDelayS({ ...s, departureS: null, exitS: s.arrivalS ?? s.exitS }, { ...a, departureS: null, exitS: a.arrivalS }, now);
      out.push({ entryId: s.id, leg: 'incoming', headcode: s.headcode, trainClass: s.trainClass, forHeadcode: null, becomes: s.ecs.onward.headcode, siding: s.ecs.siding, sortS: s.entryS, status: shift ? inStatus : 'Expected', delayS: shift ? inDelay : null, row });
      // Outgoing service: pending throughout the dwell; progresses from its own departure.
      let outStatus: ServiceStatus;
      if (!shift) outStatus = 'Expected';
      else if (ended || a.exitS !== null) outStatus = row.status;
      else if (a.departureS === null) outStatus = a.readyS !== null ? 'Ready to depart' : 'Expected';
      else outStatus = row.status === 'Held at signal' ? 'Held at signal' : 'En route to exit';
      let outDelay: number | null = null;
      if (shift && !ended) {
        if (a.exitS !== null) outDelay = row.delays.exit;
        else if (a.departureS !== null) outDelay = Math.max(row.delays.departure ?? 0, s.exitS < now ? now - s.exitS : 0);
        else if (s.departureS !== null && now > s.departureS && a.arrivalS !== null) outDelay = now - s.departureS;
      }
      out.push({ entryId: outgoingId(s.id), leg: 'outgoing', headcode: s.ecs.onward.headcode, trainClass: s.ecs.onward.trainClass, forHeadcode: s.headcode, becomes: null, siding: s.ecs.siding, sortS: s.departureS ?? s.exitS, status: outStatus, delayS: outDelay, row });
    }
    return out.map((e, i) => ({ e, i })).sort((x, y) => x.e.sortS - y.e.sortS || x.i - y.i).map((x) => x.e);
  }

  rows(shift: Shift | null = this.current): ServiceRow[] {
    const tt = shift ? shift.timetable : this.draft;
    if (!tt) return [];
    const live = shift !== null && shift === this.current && shift.status === 'running';
    const now = live ? this.nowS : (shift?.endedS ?? 0);
    return tt.services.map((service) => {
      const actual = shift?.actuals.get(service.id) ?? emptyActual();
      const train = live && actual.trainId ? (this.sim.trains.find((t) => t.id === actual.trainId) ?? null) : null;
      return {
        service,
        actual,
        status: shift ? deriveStatus(service, actual, train, now) : 'Expected',
        delayS: shift ? currentDelayS(service, actual, now) : null,
        delays: delaysOf(service, actual),
        train,
      };
    });
  }
}
