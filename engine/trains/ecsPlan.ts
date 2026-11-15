/**
 * ECS siding cycles (Phase 9): which ways can an ECS train get from an entry boundary to a siding, and from the siding
 * to an exit boundary, and where does it have to reverse?
 *
 * Nothing is assumed. The search walks the DERIVED ROUTE TABLE (signal-to-signal movements the topology and the
 * traffic directions allow), and may continue from a bay's stop signal to its departure signal (a reversal), but only if
 * the train fits the bay. A cycle that no chain of valid movements can complete simply has no plan, so a timetable can
 * never be given an impossible movement.
 *
 * Planning never sets a route or moves a train. It names what the signaller has to set, in order.
 */

import { otherEnd } from '../topology/network';
import type { SignallingContext } from '../signalling/context';
import { stockPerformance, stockProblem, type StockRef } from '../rollingstock';
import { classAllowsLine, specForStock } from './classes';
import { bayFit, sidingFit } from './ecs';
import { signalAtEnd } from './lookahead';
import { spawnTrain } from './step';
import type { SignallingState } from '../signalling/types';
import type { EcsJob, OnwardService, Train } from './types';

/** One leg of a cycle: the movements the signaller must set, in order (automatic signals clear by themselves, so they are not listed), and the reversal bays used between them. */
export interface EcsLeg {
  readonly movements: readonly string[];
  /** Reversal bays in the order they are used. */
  readonly bays: readonly string[];
  /** e.g. "AJ08 | reverse | AJ10 → AJ1": a short text for panels. */
  readonly label: string;
}

export interface EcsPlan {
  readonly id: string;
  readonly origin: string;
  readonly siding: string;
  readonly destination: string;
  readonly arrival: EcsLeg;
  readonly departure: EcsLeg;
}

export interface EcsQuery {
  readonly origin: string;
  readonly siding: string;
  readonly destination: string;
  readonly lengthM: number;
  readonly stopMarginM: number;
  /** The class (and model) the train works as AFTER the siding: it decides which lines the departure may use. Default 5. */
  readonly onwardClass?: number;
  readonly model?: string;
}

const MAX_BAYS_PER_LEG = 2;
const MAX_LEGS = 24;
const MAX_DEPTH = 22;

const cache = new WeakMap<SignallingContext, Map<string, EcsLeg[]>>();

export function searchLegs(ctx: SignallingContext, start: string, isGoal: (routeTo: string, toKind: 'signal' | 'boundary') => boolean, q: Pick<EcsQuery, 'lengthM' | 'stopMarginM'>, trainClass: number, model?: string): EcsLeg[] {
  const net = ctx.net;
  const out: EcsLeg[] = [];
  const movements: string[] = [];
  const bays: string[] = [];
  const marks: string[] = []; // text pieces for the label
  const seen = new Set<string>([start]);
  const isManual = (signalId: string): boolean => net.signals.get(signalId)?.type !== 'automatic';
  let depth = 0;

  const walk = (node: string): void => {
    if (out.length >= MAX_LEGS || depth > MAX_DEPTH) return;
    depth++;
    try {
      walkFrom(node);
    } finally {
      depth--;
    }
  };
  const walkFrom = (node: string): void => {
    for (const r of ctx.from(node)) {
      // The siding sections are exempt for the departure: the train is already inside, and the restriction is on ENTRY.
      if (!r.sections.every((s) => net.sections.get(s)?.line === 'SIDING' || classAllowsLine(trainClass, net.sections.get(s)?.line ?? 'LINK', model))) continue;
      if (isGoal(r.to, r.toKind)) {
        out.push({ movements: [...movements, ...(isManual(r.from) ? [r.id] : [])], bays: [...bays], label: [...marks, ctx.routeName(r.id)].join('  ·  ') });
        continue;
      }
      if (r.toKind === 'boundary') continue; // an exit or buffer that is not the goal
      if (seen.has(r.to)) continue;
      seen.add(r.to);
      const pushed = isManual(r.from);
      if (pushed) movements.push(r.id);
      marks.push(ctx.routeName(r.id));
      walk(r.to);
      // a reversal at this signal, if it is a bay's stop signal and the train fits
      if (bays.length < MAX_BAYS_PER_LEG) {
        for (const bay of net.reversalBays.values()) {
          if (bay.stopSignal !== r.to || seen.has(bay.departSignal) || !bayFit(net, bay.id, q.lengthM, q.stopMarginM).ok) continue;
          seen.add(bay.departSignal);
          bays.push(bay.id);
          marks.push(`reverse at ${bay.name}`);
          walk(bay.departSignal);
          marks.pop();
          bays.pop();
          seen.delete(bay.departSignal);
        }
      }
      marks.pop();
      if (pushed) movements.pop();
      seen.delete(r.to);
    }
  };
  walk(start);
  return out.sort((a, b) => a.bays.length - b.bays.length || a.movements.length - b.movements.length);
}

/** Every valid approach from `origin` to the siding's buffer stops. */
export function approachLegs(ctx: SignallingContext, q: Pick<EcsQuery, 'origin' | 'siding' | 'lengthM' | 'stopMarginM'>): EcsLeg[] {
  const key = `A|${q.origin}|${q.siding}|${q.lengthM}|${q.stopMarginM}`;
  let by = cache.get(ctx);
  if (!by) cache.set(ctx, (by = new Map()));
  const hit = by.get(key);
  if (hit) return hit;
  const net = ctx.net;
  const boundary = net.boundaries.get(q.origin);
  const sd = net.sidings.get(q.siding);
  const buffer = sd ? [...net.boundaries.values()].find((b) => b.buffer && b.at.section === sd.section)?.id : undefined;
  let legs: EcsLeg[] = [];
  if (boundary?.entry && sd && buffer && sidingFit(net, sd.id, q.lengthM).ok) {
    const first = signalAtEnd(net, { section: boundary.at.section, end: otherEnd(boundary.at.end) });
    if (first) legs = searchLegs(ctx, first.id, (to) => to === buffer, q, 5);
  }
  by.set(key, legs);
  return legs;
}

/** Every valid departure from the siding (after the train has changed ends in it) to the exit boundary. */
export function departureLegs(ctx: SignallingContext, q: Pick<EcsQuery, 'siding' | 'destination' | 'lengthM' | 'stopMarginM' | 'onwardClass' | 'model'>): EcsLeg[] {
  const cls = q.onwardClass ?? 5;
  const key = `D|${q.siding}|${q.destination}|${q.lengthM}|${q.stopMarginM}|${cls}|${q.model ?? ''}`;
  let by = cache.get(ctx);
  if (!by) cache.set(ctx, (by = new Map()));
  const hit = by.get(key);
  if (hit) return hit;
  const net = ctx.net;
  const sd = net.sidings.get(q.siding);
  const dest = net.boundaries.get(q.destination);
  const legs = sd && dest?.exit && !dest.buffer ? searchLegs(ctx, sd.exitSignal, (to, kind) => kind === 'boundary' && to === q.destination, q, cls, q.model) : [];
  by.set(key, legs);
  return legs;
}

/** All complete cycles (approach × departure) for the query, simplest first. */
export function planEcsCycles(ctx: SignallingContext, q: EcsQuery): EcsPlan[] {
  const plans: EcsPlan[] = [];
  const dep = departureLegs(ctx, q);
  for (const a of approachLegs(ctx, q)) {
    for (const d of dep) plans.push({ id: `${q.origin}>${q.siding}>${q.destination}#${plans.length + 1}`, origin: q.origin, siding: q.siding, destination: q.destination, arrival: a, departure: d });
  }
  return plans.sort((x, y) => x.arrival.bays.length + x.departure.bays.length - (y.arrival.bays.length + y.departure.bays.length));
}

// ---------------------------------------------------------------------------
// Creating the train
// ---------------------------------------------------------------------------

export interface EcsRequest {
  /** Incoming headcode (Class 5). */
  readonly headcode: string;
  readonly model: string;
  readonly formation: string;
  readonly origin: string;
  readonly siding: string;
  readonly onward: OnwardService;
  readonly stablingS: number;
  /** The plan to follow; omitted: the simplest valid one. */
  readonly plan?: EcsPlan;
}

export type EcsCreateResult = { readonly ok: true; readonly sig: SignallingState; readonly train: Train; readonly plan: EcsPlan } | { readonly ok: false; readonly reason: string };

/**
 * Validates and creates an ECS train waiting at its boundary. Everything is checked first: the headcodes, that the stock
 * may work Class 5 and the onward class, that the whole train fits the siding, and that a valid approach and departure
 * exist for THIS train (its length decides which bays it fits). Nothing is set or moved.
 */
export function createEcsTrain(ctx: SignallingContext, sig: SignallingState, existing: readonly Train[], req: EcsRequest, id: string): EcsCreateResult {
  const hc = (s: string): boolean => /^[0-9][A-Z][0-9]{2}$/.test(s);
  if (!hc(req.headcode)) return { ok: false, reason: `Headcode "${req.headcode}" is not valid.` };
  if (!hc(req.onward.headcode)) return { ok: false, reason: `Onward headcode "${req.onward.headcode}" is not valid.` };
  if (req.headcode === req.onward.headcode) return { ok: false, reason: 'The onward headcode must differ from the incoming one.' };
  for (const h of [req.headcode, req.onward.headcode]) if (existing.some((t) => !t.finished && t.spec.headcode === h)) return { ok: false, reason: `Headcode ${h} is already in use.` };
  const stock: StockRef = { model: req.model, formation: req.formation };
  const p5 = stockProblem(5, stock);
  if (p5) return { ok: false, reason: p5 };
  const pOn = stockProblem(req.onward.trainClass, stock);
  if (pOn) return { ok: false, reason: `Onward service: ${pOn}` };
  const perf = stockPerformance(stock);
  const spec = specForStock(5, stock, { headcode: req.headcode, origin: req.origin, destination: req.onward.destination });
  const fit = sidingFit(ctx.net, req.siding, perf.lengthM);
  if (!fit.ok) return { ok: false, reason: fit.reason };
  const plan = req.plan ?? planEcsCycles(ctx, { origin: req.origin, siding: req.siding, destination: req.onward.destination, lengthM: perf.lengthM, stopMarginM: spec.stopMarginM, onwardClass: req.onward.trainClass, model: req.model })[0];
  if (!plan) return { ok: false, reason: `No valid movement takes this train from ${req.origin} into ${ctx.net.sidings.get(req.siding)?.name ?? req.siding} and out to ${req.onward.destination}.` };
  const job: EcsJob = {
    incomingHeadcode: req.headcode,
    siding: req.siding,
    bayQueue: plan.arrival.bays,
    departureBays: plan.departure.bays,
    approachPlan: plan.arrival.movements,
    departurePlan: plan.departure.movements,
    stablingS: req.stablingS,
    stablingRemainingS: req.stablingS,
    onward: req.onward,
    stage: 'inbound',
    reversal: null,
    reversals: 0,
    note: '',
  };
  const sp = spawnTrain(ctx.net, sig, spec, id, { id, plan: plan.arrival.movements, ecs: job });
  if (!sp.ok) return { ok: false, reason: sp.reason };
  return { ok: true, sig: sp.sig, train: sp.train, plan };
}

// ---------------------------------------------------------------------------
// What the signaller should set next (used by the lone-train measurement and by the tests-only bots)
// ---------------------------------------------------------------------------

/**
 * The next movement of the train's cycle that can be set now, or null. Movements are set in order, one ahead: a movement
 * is offered once the previous one's signal has been passed. A movement that follows a reversal is offered only when the
 * train has finished changing ends and faces the right signal, and the departure is offered only once the train is ready.
 * `done` holds the keys already set ("a:" approach, "d:" departure); the caller adds a key when the route is set.
 */
export function nextEcsMovement(ctx: SignallingContext, sig: SignallingState, train: Train, done: ReadonlySet<string>): { key: string; movement: string } | null {
  const job = train.ecs;
  if (!job || train.finished) return null;
  const approach = job.stage === 'inbound';
  const plan = approach ? job.approachPlan : job.departurePlan;
  const tag = approach ? 'a' : 'd';
  if (!approach && job.stage !== 'ready' && job.stage !== 'leaving' && job.stage !== 'onward') return null;
  for (let k = 0; k < plan.length; k++) {
    const id = plan[k] as string;
    if (done.has(`${tag}:${id}`)) continue;
    const r = ctx.route(id);
    if (!r) return null;
    const prev = k > 0 ? ctx.route(plan[k - 1] as string) : undefined;
    // one ahead: the previous movement's signal must have been passed (it no longer owns the route)
    // ...except the shunting route that follows a shunting access route: the access route only works once the shunting signal shows Proceed.
    if (prev && sig.routes[prev.from] === prev.id && !(prev.shuntAccess && r.from === prev.to)) return null;
    // after a reversal (a bay's departure signal, or the siding's exit signal): only when the train is ready at it
    const bay = [...ctx.net.reversalBays.values()].find((b) => b.departSignal === r.from && prev !== undefined && prev.to === b.stopSignal);
    const sidingExit = k === 0 && !approach;
    if (bay || sidingExit) {
      const rev = job.reversal;
      const ok = rev !== null && rev.phase === 'ready' && (bay ? rev.kind === 'bay' && rev.bay === bay.id : rev.kind === 'siding');
      if (!ok) return null;
    }
    return { key: `${tag}:${id}`, movement: id };
  }
  return null;
}
