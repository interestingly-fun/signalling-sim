/**
 * The running simulation: one signalling state, a fleet of trains, and a
 * fixed-step clock. Plain TypeScript with no React, so it can be driven by a
 * test with invented frame times exactly as the browser drives it with
 * requestAnimationFrame.
 *
 * The signalling state lives here (not in a React component) because the trains
 * change it every step (occupancy, route release) while the signaller changes
 * it between steps (routes, points). Both go through `setSig`.
 *
 * Rendering is separate from simulation: `advance(seconds)` runs zero or more
 * FIXED steps, and `view()` returns the train interpolated between its last two
 * steps, so on-screen motion is smooth at any frame rate.
 */

import {
  FixedStepClock,
  createTrain,
  removeAll,
  removeTrain,
  stepFleet,
  canRemoveUnentered,
  type CreateResult,
  type ServicePlan,
  type SignallingContext,
  type SignallingState,
  type Train,
  type TrainEvent,
  type TrainRequest,
} from '../../engine';

export const STEP_SECONDS = 0.05;

export type SimMode = 'no-train' | 'ready' | 'running' | 'paused' | 'finished';

export interface TrainView {
  readonly train: Train;
  /** Front position interpolated between the last two fixed steps. */
  readonly frontM: number;
  readonly rearM: number;
  readonly selected: boolean;
}

type Listener = () => void;

export class Simulation {
  private sigState: SignallingState;
  private fleet: readonly Train[] = [];
  private previousFront = new Map<string, number>();
  private plans = new Map<string, ServicePlan>();
  private selected: string | null = null;
  private counter = 0;
  private paused = false;
  private frame = 0;
  private sigListeners = new Set<Listener>();
  private frameListeners = new Set<Listener>();
  private eventListeners = new Set<(events: readonly TrainEvent[]) => void>();
  /** A frame longer than this many REAL seconds (hidden tab, debugger stop) is cut short, then scaled by the speed multiplier. */
  private static readonly MAX_REAL_FRAME_S = 0.25;
  private readonly clock = new FixedStepClock(STEP_SECONDS, 60);

  /** Simulated seconds per real second. */
  speedFactor = 1;
  /** Simulated seconds since the clock was last zeroed (shift start or reset). The source of truth for timetable events. */
  clockS = 0;
  /** While true the clock runs even with no train in the area (a shift is waiting for its next service). */
  clockActive = false;
  private stepHooks = new Set<() => void>();
  /** Receives an internal failure during a step (the simulation is paused first). Without one the error is rethrown. */
  onError: ((e: unknown) => void) | null = null;
  /** Fixed steps run since the fleet was last empty (for tests). */
  stepsRun = 0;

  constructor(
    readonly ctx: SignallingContext,
    initial: SignallingState,
  ) {
    this.sigState = initial;
  }

  // --- subscriptions (React reads these through useSyncExternalStore) ---------
  readonly subscribeSig = (fn: Listener): (() => void) => {
    this.sigListeners.add(fn);
    return () => this.sigListeners.delete(fn);
  };
  readonly subscribeFrame = (fn: Listener): (() => void) => {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  };
  onEvents(fn: (events: readonly TrainEvent[]) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }
  readonly getSig = (): SignallingState => this.sigState;
  readonly getFrame = (): number => this.frame;

  /** Every train created and not yet removed (completed ones included, until cleared). */
  get trains(): readonly Train[] {
    return this.fleet;
  }
  /** Trains still in play: not completed. */
  get activeTrains(): readonly Train[] {
    return this.fleet.filter((t) => !t.finished);
  }
  get selectedId(): string | null {
    return this.selected;
  }
  /** The selected train, or the first live one when none is selected. */
  get train(): Train | null {
    return this.fleet.find((t) => t.id === this.selected) ?? this.fleet.find((t) => !t.finished) ?? this.fleet[0] ?? null;
  }
  planOf(id: string): ServicePlan | undefined {
    return this.plans.get(id);
  }
  get isPaused(): boolean {
    return this.paused;
  }

  /** Signaller or test-control change. The trains see it from the next step. */
  readonly setSig = (next: SignallingState): void => {
    if (next === this.sigState) return;
    this.sigState = next;
    for (const l of this.sigListeners) l();
  };

  /** Changes the simulation speed multiplier (simulated seconds per real second). */
  setSpeed(factor: number): void {
    this.speedFactor = factor;
    this.notifyFrame();
  }

  /** Runs after every fixed step, with the clock already advanced. */
  addStepHook(fn: () => void): () => void {
    this.stepHooks.add(fn);
    return () => this.stepHooks.delete(fn);
  }

  get mode(): SimMode {
    if (this.clockActive) return this.paused ? 'paused' : 'running';
    if (this.fleet.length === 0) return 'no-train';
    const live = this.fleet.filter((t) => !t.finished);
    if (live.length === 0) return 'finished';
    if (!live.some((t) => t.started)) return 'ready';
    return this.paused ? 'paused' : 'running';
  }

  select(id: string | null): void {
    this.selected = id !== null && this.fleet.some((t) => t.id === id) ? id : null;
    this.notifyFrame();
  }

  // --- controls -------------------------------------------------------------------
  /** Creates a train waiting outside its boundary. Validates class, route, platform and fit; sets nothing. */
  create(req: TrainRequest): CreateResult {
    this.counter++;
    const r = createTrain(this.ctx, this.sigState, this.fleet, req, `T${this.counter}`);
    if (!r.ok) {
      this.counter--;
      return r;
    }
    if (this.fleet.every((t) => t.finished)) this.stepsRun = 0;
    this.fleet = [...this.fleet, r.train];
    this.plans.set(r.train.id, r.plan);
    this.previousFront.set(r.train.id, r.train.frontM);
    this.selected = r.train.id;
    this.setSig(r.sig);
    this.notifyFrame();
    return r;
  }

  /**
   * A scheduled service (Phase 5): created at its boundary and released at once, so it enters at its
   * entry speed as soon as the interlocking and the line ahead allow. Platform availability is not
   * checked here: the train waits at a signal like any other. The selection is not changed.
   */
  createScheduled(req: TrainRequest): CreateResult {
    this.counter++;
    const r = createTrain(this.ctx, this.sigState, this.fleet, req, `T${this.counter}`, { ignorePlatformAvailability: true });
    if (!r.ok) {
      this.counter--;
      return r;
    }
    const train = { ...r.train, started: true, holdReason: '' };
    this.fleet = [...this.fleet, train];
    this.plans.set(train.id, r.plan);
    this.previousFront.set(train.id, train.frontM);
    this.setSig(r.sig);
    this.notifyFrame();
    return { ...r, train };
  }

  /** Replaces one train's state (used to hold a departure to its scheduled time). */
  updateTrain(id: string, fn: (t: Train) => Train): void {
    const t = this.fleet.find((x) => x.id === id);
    if (t) this.replace(fn(t));
  }

  /**
   * Start-of-shift reset: every train, route, lock, occupancy marker, point and override back to the
   * initial state, and the clock to zero.
   */
  resetAll(initial: SignallingState): void {
    this.fleet = [];
    this.previousFront.clear();
    this.plans.clear();
    this.selected = null;
    this.paused = false;
    this.stepsRun = 0;
    this.clockS = 0;
    this.clock.reset();
    this.setSig(initial);
    this.notifyFrame();
  }

  /** Lets a waiting train go: it is admitted at its entry speed as soon as the line ahead allows. */
  start(id?: string): boolean {
    const target = id ?? this.train?.id;
    const t = this.fleet.find((x) => x.id === target);
    if (!t || t.finished || t.started) return false;
    this.replace({ ...t, started: true, holdReason: '' });
    this.paused = false;
    this.notifyFrame();
    return true;
  }

  startAll(): number {
    let n = 0;
    for (const t of this.fleet) if (!t.finished && !t.started && this.start(t.id)) n++;
    return n;
  }

  /** Removes a train that has not yet entered the area (or a completed one). Nothing it held needs releasing. */
  remove(id: string): boolean {
    const t = this.fleet.find((x) => x.id === id);
    if (!t || !(canRemoveUnentered(t) || t.finished)) return false;
    this.setSig(removeTrain(this.ctx, this.sigState, t));
    this.fleet = this.fleet.filter((x) => x.id !== id);
    this.previousFront.delete(id);
    this.plans.delete(id);
    if (this.selected === id) this.selected = null;
    this.notifyFrame();
    return true;
  }

  clearCompleted(): void {
    for (const t of this.fleet.filter((x) => x.finished)) this.remove(t.id);
  }

  pause(): void {
    if (this.mode === 'running') this.paused = true;
    this.notifyFrame();
  }

  resume(): void {
    if (this.mode === 'paused') this.paused = false;
    this.notifyFrame();
  }

  /** Removes every train and frees what they hold. Routes set by the signaller are left as they are. */
  reset(): void {
    this.setSig(removeAll(this.ctx, this.sigState, this.fleet));
    this.fleet = [];
    this.previousFront.clear();
    this.plans.clear();
    this.selected = null;
    this.paused = false;
    this.stepsRun = 0;
    this.clockS = 0;
    this.clockActive = false;
    this.clock.reset();
    this.notifyFrame();
  }

  // --- time -----------------------------------------------------------------------
  /** Feed real elapsed seconds (one animation frame). Returns the number of fixed steps run. */
  advance(realSeconds: number): number {
    if (this.paused || (!this.clockActive && !this.fleet.some((t) => t.started && !t.finished))) return 0; // nothing moves, nothing to redraw
    const steps = this.clock.advance(Math.min(realSeconds, Simulation.MAX_REAL_FRAME_S) * this.speedFactor);
    let ran = 0;
    try {
      for (; ran < steps; ran++) this.stepOnce();
    } catch (e) {
      // An internal failure must not kill the animation loop or repeat every frame: pause and report.
      if (!this.onError) throw e;
      this.paused = true;
      this.onError(e);
    }
    this.notifyFrame();
    return ran;
  }

  /** Runs exactly one fixed step for every train (used by `advance` and by tests). */
  stepOnce(): void {
    if (!this.clockActive && this.fleet.every((t) => t.finished)) return;
    for (const t of this.fleet) this.previousFront.set(t.id, t.frontM);
    const r = stepFleet(this.ctx, this.sigState, this.fleet, STEP_SECONDS);
    this.fleet = r.trains;
    this.stepsRun++;
    this.setSig(r.sig);
    this.clockS += STEP_SECONDS;
    if (r.events.length > 0) for (const l of this.eventListeners) l(r.events);
    for (const h of this.stepHooks) h();
  }

  /** The trains for drawing, interpolated between the last two steps. Completed trains are not drawn. */
  views(): TrainView[] {
    const running = !this.paused;
    const alpha = running ? this.clock.alpha : 0;
    const selected = this.train?.id ?? null;
    return this.fleet
      .filter((t) => !t.finished)
      .map((t) => {
        const prev = this.previousFront.get(t.id) ?? t.frontM;
        const frontM = running && t.started ? prev + (t.frontM - prev) * alpha : t.frontM;
        return { train: t, frontM, rearM: frontM - t.spec.lengthM, selected: t.id === selected };
      });
  }

  /** The selected train for drawing (compatibility with single-train callers). */
  view(): TrainView | null {
    const sel = this.train;
    return this.views().find((v) => v.train.id === sel?.id) ?? null;
  }

  private replace(next: Train): void {
    this.fleet = this.fleet.map((t) => (t.id === next.id ? next : t));
  }

  private notifyFrame(): void {
    this.frame++;
    for (const l of this.frameListeners) l();
  }
}
