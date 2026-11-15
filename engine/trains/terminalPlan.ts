/**
 * Terminating cycles (Northbridge): which ways can a train get from an entry boundary to a terminus platform, and from that platform
 * (after changing ends) to an exit boundary? Like the ECS planner, the search walks the DERIVED ROUTE TABLE, so a cycle that no chain of
 * valid movements can complete has no plan, and the corridor and platform-access rules hold by construction: they are re-checked here.
 */

import { otherEnd } from '../topology/network';
import type { SignallingContext } from '../signalling/context';
import type { SignallingState } from '../signalling/types';
import { stockPerformance, stockProblem, type StockRef } from '../rollingstock';
import { specForStock } from './classes';
import { boundaryCorridor, platformAllows } from './corridors';
import { searchLegs, type EcsLeg } from './ecsPlan';
import { signalAtEnd } from './lookahead';
import { platformFit } from './platforms';
import { spawnTrain } from './step';
import type { OnwardService, TerminalJob, Train } from './types';

export interface TerminalPlan {
  readonly id: string;
  readonly origin: string;
  /** The terminus platform id (e.g. 'T3'). */
  readonly platform: string;
  readonly destination: string;
  readonly arrival: EcsLeg;
  readonly departure: EcsLeg;
}

export interface TerminalQuery {
  readonly origin: string;
  readonly platform: string;
  readonly destination: string;
  readonly lengthM: number;
  readonly stopMarginM: number;
  readonly trainClass: number;
  readonly onwardClass: number;
  readonly model?: string;
}

const cache = new WeakMap<SignallingContext, Map<string, TerminalPlan[]>>();

/** Every complete cycle (approach × departure) for the query, simplest first. Empty when the rules or the geometry forbid it. */
export function planTerminalCycles(ctx: SignallingContext, q: TerminalQuery): TerminalPlan[] {
  const key = `${q.origin}|${q.platform}|${q.destination}|${q.lengthM}|${q.trainClass}|${q.onwardClass}|${q.model ?? ''}`;
  let by = cache.get(ctx);
  if (!by) cache.set(ctx, (by = new Map()));
  const hit = by.get(key);
  if (hit) return hit;
  const net = ctx.net;
  const plans: TerminalPlan[] = [];
  const term = (net.def.terminals ?? []).find((t) => t.platform === q.platform);
  const from = net.boundaries.get(q.origin);
  const dest = net.boundaries.get(q.destination);
  const corridor = boundaryCorridor(net, q.origin);
  const sameCorridor = boundaryCorridor(net, q.destination) === corridor;
  if (term && from?.entry && dest?.exit && !dest.buffer && sameCorridor && platformAllows(net, q.platform, corridor) && platformFit(net, q.platform, q.lengthM).ok) {
    const first = signalAtEnd(net, { section: from.at.section, end: otherEnd(from.at.end) });
    const arrivals = first ? searchLegs(ctx, first.id, (to) => to === term.buffer, q, q.trainClass, q.model) : [];
    const departures = searchLegs(ctx, term.departSignal, (to, kind) => kind === 'boundary' && to === q.destination, q, q.onwardClass, q.model);
    for (const a of arrivals) for (const d of departures) plans.push({ id: `${q.origin}>${q.platform}>${q.destination}#${plans.length + 1}`, origin: q.origin, platform: q.platform, destination: q.destination, arrival: a, departure: d });
  }
  plans.sort((x, y) => x.arrival.movements.length + x.departure.movements.length - (y.arrival.movements.length + y.departure.movements.length));
  by.set(key, plans);
  return plans;
}

export interface TerminalRequest {
  readonly headcode: string;
  readonly trainClass: 1 | 2 | 5;
  readonly model: string;
  readonly formation: string;
  readonly origin: string;
  /** Terminus platform id. */
  readonly platform: string;
  readonly terminalDwellS: number;
  readonly onward: OnwardService;
  /** Optional call at a Northbridge-West platform on the way in / on the way out. */
  readonly inboundCall?: { readonly platform: string; readonly dwellS: number } | null;
  readonly outboundCall?: { readonly platform: string; readonly dwellS: number } | null;
  readonly plan?: TerminalPlan;
}

export type TerminalCreateResult = { readonly ok: true; readonly sig: SignallingState; readonly train: Train; readonly plan: TerminalPlan } | { readonly ok: false; readonly reason: string };

export function createTerminalTrain(ctx: SignallingContext, sig: SignallingState, existing: readonly Train[], req: TerminalRequest, id: string): TerminalCreateResult {
  const hc = (s: string): boolean => /^[0-9][A-Z][0-9]{2}$/.test(s);
  if (!hc(req.headcode) || !hc(req.onward.headcode)) return { ok: false, reason: `Headcode "${hc(req.headcode) ? req.onward.headcode : req.headcode}" is not valid.` };
  if (req.headcode === req.onward.headcode) return { ok: false, reason: 'The onward headcode must differ from the incoming one.' };
  for (const h of [req.headcode, req.onward.headcode]) if (existing.some((t) => !t.finished && t.spec.headcode === h)) return { ok: false, reason: `Headcode ${h} is already in use.` };
  const stock: StockRef = { model: req.model, formation: req.formation };
  const p1 = stockProblem(req.trainClass, stock);
  if (p1) return { ok: false, reason: p1 };
  const p2 = stockProblem(req.onward.trainClass, stock);
  if (p2) return { ok: false, reason: `Onward service: ${p2}` };
  const perf = stockPerformance(stock);
  const stops = [...(req.inboundCall ? [req.inboundCall] : []), { platform: req.platform, dwellS: req.terminalDwellS }, ...(req.outboundCall ? [req.outboundCall] : [])];
  const spec = specForStock(req.trainClass, stock, { headcode: req.headcode, origin: req.origin, destination: req.onward.destination, stop: { platform: (stops[0] as { platform: string }).platform, dwellS: (stops[0] as { dwellS: number }).dwellS } });
  const plan = req.plan ?? planTerminalCycles(ctx, { origin: req.origin, platform: req.platform, destination: req.onward.destination, lengthM: perf.lengthM, stopMarginM: spec.stopMarginM, trainClass: req.trainClass, onwardClass: req.onward.trainClass, model: req.model })[0];
  if (!plan) return { ok: false, reason: `No valid movement takes this train from ${req.origin} to ${ctx.net.platforms.get(req.platform)?.name ?? req.platform} and out to ${req.onward.destination}.` };
  const job: TerminalJob = { stage: 'inbound', incomingHeadcode: req.headcode, terminal: req.platform, onward: req.onward, stops: stops.slice(1), approachPlan: plan.arrival.movements, departurePlan: plan.departure.movements, remainingS: 0, reversals: 0, note: '' };
  const sp = spawnTrain(ctx.net, sig, spec, id, { id, plan: plan.arrival.movements, terminal: job });
  if (!sp.ok) return { ok: false, reason: sp.reason };
  return { ok: true, sig: sp.sig, train: sp.train, plan };
}

/**
 * The next movement of the train's cycle that can be set now, or null (used by the lone-train measurement and the tests-only bots).
 * Movements are offered one ahead; the departure only once the train has changed ends and stands ready at the departure signal.
 */
export function nextTerminalMovement(ctx: SignallingContext, sig: SignallingState, train: Train, done: ReadonlySet<string>): { key: string; movement: string } | null {
  const job = train.terminal;
  if (!job || train.finished) return null;
  const approach = job.stage === 'inbound';
  if (!approach && job.stage !== 'ready' && job.stage !== 'leaving' && job.stage !== 'done') return null;
  const plan = approach ? job.approachPlan : job.departurePlan;
  const tag = approach ? 'a' : 'd';
  for (let k = 0; k < plan.length; k++) {
    const id = plan[k] as string;
    if (done.has(`${tag}:${id}`)) continue;
    const r = ctx.route(id);
    if (!r) return null;
    const prev = k > 0 ? ctx.route(plan[k - 1] as string) : undefined;
    if (prev && sig.routes[prev.from] === prev.id) return null;
    return { key: `${tag}:${id}`, movement: id };
  }
  return null;
}
