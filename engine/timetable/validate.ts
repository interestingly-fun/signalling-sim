/**
 * Timetable validation (Phase 5). Independent of the generator: it re-derives
 * everything from the logical network and the measured journey profiles, so a
 * timetable from any source (generator, fallback, hand-written) is checked the
 * same way. A timetable with ANY issue is never accepted.
 */

import type { SignallingContext } from '../signalling';
import { isFlexibleClass1, stockPerformance, stockProblem } from '../rollingstock';
import { boundaryCorridor, classAllowsLine, permissionsFor, planEcsCycles, planTerminalCycles, platformAllows, platformFit, planServices, sidingFit, type EcsPlan, type TerminalPlan } from '../trains';
import { ecsIntervals, ecsProfile, journeyProfile, terminalProfile, type EcsProfile, type JourneyProfile, type TerminalProfile } from './profile';
import { headcodesOf, stockOf, type ServiceSchedule, type Timetable } from './types';

/** Two services may not use the same section or point within this many seconds of each other. */
export const SEPARATION_S = 45;
/** Two trains entering at the same boundary must be at least this far apart. */
export const ENTRY_HEADWAY_S = 150;
export const MIN_SERVICES = 5;
/** The most services a shift may have (the largest difficulty target). */
export const MAX_SERVICES = 25;
const EPS = 1.5;

export const HEADCODE_RE = /^[0-9][A-Z][0-9]{2}$/;

export interface Window {
  readonly resource: string;
  readonly from: number;
  readonly to: number;
}

/** Windows (absolute shift seconds) in which a service holds each section and each point. */
export function resourceWindows(ctx: SignallingContext, s: ServiceSchedule, profile: JourneyProfile): Window[] {
  const out: Window[] = [];
  const secs = profile.sections;
  for (const [sec, [a, b]] of Object.entries(secs)) {
    // Two sections that cross on the flat (the diamond) are ONE resource: a train on either blocks the other.
    const crosses = ctx.net.sections.get(sec)?.crosses;
    const resource = crosses && crosses.length > 0 ? `crossing ${[sec, ...crosses].sort().join('/')}` : `section ${sec}`;
    out.push({ resource, from: s.entryS + a, to: s.entryS + b });
  }
  for (const p of ctx.net.points.values()) {
    const touched = [p.toe.section, p.normal.section, p.reverse.section].filter((x) => secs[x] !== undefined);
    if (touched.length < 2) continue; // the service does not run through this point
    const from = Math.min(...touched.map((x) => (secs[x] as readonly [number, number])[0]));
    const to = Math.max(...touched.map((x) => (secs[x] as readonly [number, number])[1]));
    out.push({ resource: `point ${p.id}`, from: s.entryS + from, to: s.entryS + to });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ECS siding cycles (Phase 9)
// ---------------------------------------------------------------------------

/** Planned stabling time limits (seconds). */
export const MIN_STABLING_S = 120;
export const MAX_STABLING_S = 900;

/** The cycle plan a scheduled ECS service refers to (its listed movements), or undefined if the network no longer offers it. */
const ecsPlansCache = new WeakMap<SignallingContext, Map<string, readonly EcsPlan[]>>();
export function ecsPlanOf(ctx: SignallingContext, s: ServiceSchedule): EcsPlan | undefined {
  const e = s.ecs;
  if (!e) return undefined;
  let m = ecsPlansCache.get(ctx);
  if (!m) ecsPlansCache.set(ctx, (m = new Map()));
  const key = `${s.origin}|${e.siding}|${e.onward.destination}|${s.model}|${s.formation}|${e.onward.trainClass}`;
  let plans = m.get(key);
  if (!plans) {
    const lengthM = stockPerformance(stockOf(s)).lengthM;
    m.set(key, (plans = planEcsCycles(ctx, { origin: s.origin, siding: e.siding, destination: e.onward.destination, lengthM, stopMarginM: 12, onwardClass: e.onward.trainClass, model: s.model })));
  }
  return plans.find((p) => p.arrival.movements.join('|') === e.approach.join('|') && p.departure.movements.join('|') === e.departure.join('|'));
}

/** The measured profile of a scheduled ECS cycle, or null. */
export function ecsProfileOf(ctx: SignallingContext, s: ServiceSchedule): EcsProfile | null {
  const plan = ecsPlanOf(ctx, s);
  if (!plan || !s.ecs) return null;
  return ecsProfile(ctx, { stock: stockOf(s), origin: s.origin, siding: s.ecs.siding, onward: { headcode: s.ecs.onward.headcode, trainClass: s.ecs.onward.trainClass, destination: s.ecs.onward.destination }, plan });
}

/** Windows from a set of occupied/reserved intervals per section: every interval, and the points between. */
export function windowsFromIntervals(ctx: SignallingContext, s: ServiceSchedule, iv: Readonly<Record<string, readonly (readonly [number, number])[]>>): Window[] {
  const out: Window[] = [];
  const resourceOf = (sec: string): string => {
    const crosses = ctx.net.sections.get(sec)?.crosses;
    return crosses && crosses.length > 0 ? `crossing ${[sec, ...crosses].sort().join('/')}` : `section ${sec}`;
  };
  for (const [sec, list] of Object.entries(iv)) for (const [a, b] of list) out.push({ resource: resourceOf(sec), from: s.entryS + a, to: s.entryS + b });
  for (const pt of ctx.net.points.values()) {
    const touched = [pt.toe.section, pt.normal.section, pt.reverse.section];
    const parts = touched.flatMap((sec) => (iv[sec] ?? []).map(([a, b]) => ({ sec, a, b }))).sort((x, y) => x.a - y.a);
    let cluster: typeof parts = [];
    const flush = (): void => {
      if (new Set(cluster.map((c) => c.sec)).size >= 2) out.push({ resource: `point ${pt.id}`, from: s.entryS + Math.min(...cluster.map((c) => c.a)), to: s.entryS + Math.max(...cluster.map((c) => c.b)) });
      cluster = [];
    };
    for (const part of parts) {
      if (cluster.length > 0 && part.a > Math.max(...cluster.map((c) => c.b)) + 30) flush();
      cluster.push(part);
    }
    flush();
  }
  return out;
}

/** Windows of an ECS cycle: every interval each section is held (the siding through the whole stabling), and the points between. */
export function ecsResourceWindows(ctx: SignallingContext, s: ServiceSchedule, p: EcsProfile): Window[] {
  return windowsFromIntervals(ctx, s, ecsIntervals(p, s.ecs?.stablingS ?? 0));
}

// ---------------------------------------------------------------------------
// Terminating services (Northbridge)
// ---------------------------------------------------------------------------

const terminalPlansCache = new WeakMap<SignallingContext, Map<string, readonly TerminalPlan[]>>();
/** The cycle plan a scheduled terminating service refers to, or undefined if the network no longer offers it. */
export function terminalPlanOf(ctx: SignallingContext, s: ServiceSchedule): TerminalPlan | undefined {
  const e = s.ecs;
  if (!e?.terminal) return undefined;
  let m = terminalPlansCache.get(ctx);
  if (!m) terminalPlansCache.set(ctx, (m = new Map()));
  const key = `${s.origin}|${e.siding}|${e.onward.destination}|${s.model}|${s.formation}|${s.trainClass}|${e.onward.trainClass}`;
  let plans = m.get(key);
  if (!plans) {
    const lengthM = stockPerformance(stockOf(s)).lengthM;
    m.set(key, (plans = planTerminalCycles(ctx, { origin: s.origin, platform: e.siding, destination: e.onward.destination, lengthM, stopMarginM: 12, trainClass: s.trainClass, onwardClass: e.onward.trainClass, model: s.model })));
  }
  return plans.find((p) => p.arrival.movements.join('|') === e.approach.join('|') && p.departure.movements.join('|') === e.departure.join('|'));
}

export function terminalProfileOf(ctx: SignallingContext, s: ServiceSchedule): TerminalProfile | null {
  const plan = terminalPlanOf(ctx, s);
  const e = s.ecs;
  if (!plan || !e?.terminal) return null;
  return terminalProfile(ctx, { stock: stockOf(s), trainClass: s.trainClass, origin: s.origin, platform: e.siding, terminalDwellS: e.terminal.dwellS, onward: { headcode: e.onward.headcode, trainClass: e.onward.trainClass, destination: e.onward.destination }, inboundCall: e.terminal.inboundCall, outboundCall: e.terminal.outboundCall, plan });
}

/** Every reason a terminating service is invalid. */
export function validateTerminalService(ctx: SignallingContext, s: ServiceSchedule): string[] {
  const net = ctx.net;
  const e = s.ecs;
  const tag = s.headcode;
  const issues: string[] = [];
  if (!e?.terminal) return issues;
  const on = e.onward;
  if (!HEADCODE_RE.test(on.headcode)) issues.push(`${tag}: invalid onward headcode ${on.headcode}.`);
  else if (on.headcode[0] !== String(on.trainClass)) issues.push(`${tag}: the first digit of the onward headcode ${on.headcode} must be its class (${on.trainClass}).`);
  if (on.headcode === s.headcode) issues.push(`${tag}: the onward headcode must differ from the incoming one.`);
  const problem = stockProblem(on.trainClass, stockOf(s));
  if (problem) issues.push(`${tag}: onward service: ${problem}`);
  const term = (net.def.terminals ?? []).find((t) => t.platform === e.siding);
  if (!term) return [...issues, `${tag}: ${e.siding} is not a terminating platform.`];
  const corridor = boundaryCorridor(net, s.origin);
  if (!platformAllows(net, term.platform, corridor)) issues.push(`${tag}: ${net.platforms.get(term.platform)?.name ?? term.platform} is not open to ${corridor} corridor trains.`);
  if (boundaryCorridor(net, on.destination) !== corridor) issues.push(`${tag}: ${on.destination} is in another corridor than ${s.origin}.`);
  for (const c of [e.terminal.inboundCall, e.terminal.outboundCall]) {
    if (!c) continue;
    if (!permissionsFor(s.trainClass, s.model).canStop) issues.push(`${tag}: Class ${s.trainClass} cannot stop.`);
    if (!platformAllows(net, c.platform, corridor)) issues.push(`${tag}: ${c.platform} is not open to ${corridor} corridor trains.`);
    if (!platformFit(net, c.platform, stockPerformance(stockOf(s)).lengthM).ok) issues.push(`${tag}: the train does not fit ${c.platform}.`);
  }
  if (e.terminal.dwellS < 30) issues.push(`${tag}: terminal dwell ${e.terminal.dwellS} s is too short.`);
  if (!net.boundaries.get(s.origin)?.entry) issues.push(`${tag}: ${s.origin} is not an entry.`);
  if (!net.boundaries.get(s.destination)?.exit) issues.push(`${tag}: ${s.destination} is not an exit.`);
  if (s.destination !== on.destination) issues.push(`${tag}: the schedule's destination must be the onward one.`);
  const plan = terminalPlanOf(ctx, s);
  if (!plan) return [...issues, `${tag}: no valid movement plan matches this service (${s.origin} → ${e.siding} → ${on.destination}).`];
  const prof = terminalProfileOf(ctx, s);
  if (!prof) return [...issues, `${tag}: the service cannot be completed by a lone train in the simulation.`];
  if (s.entryS < 0) issues.push(`${tag}: scheduled to enter before the shift starts.`);
  if (s.arrivalS === null || s.departureS === null) return [...issues, `${tag}: a terminating service needs scheduled arrival and departure times.`];
  if (s.arrivalS < s.entryS + prof.entryToArrivalS - EPS) issues.push(`${tag}: scheduled to arrive at the terminus before it can physically get there.`);
  if (s.departureS < s.entryS + prof.entryToDepartureS - EPS) issues.push(`${tag}: scheduled to depart the terminus before its dwell and reversal can finish.`);
  if (s.exitS < s.entryS + prof.entryToExitS - EPS) issues.push(`${tag}: scheduled to exit before its journey can be completed.`);
  return issues;
}

const plansCache = new WeakMap<SignallingContext, Map<string, ReturnType<typeof planServices>>>();
/** `planServices` is deterministic and not cheap: its answers are remembered for the life of the network context. */
function plansFor(ctx: SignallingContext, s: ServiceSchedule): ReturnType<typeof planServices> {
  let m = plansCache.get(ctx);
  if (!m) plansCache.set(ctx, (m = new Map()));
  const key = `${s.trainClass}|${s.origin}|${s.destination}|${s.platform ?? ''}|${s.model}|${s.formation}`;
  let v = m.get(key);
  if (!v) m.set(key, (v = planServices(ctx, { trainClass: s.trainClass, origin: s.origin, destination: s.destination, platform: s.platform, lengthM: stockPerformance(stockOf(s)).lengthM, model: s.model })));
  return v;
}

/** Profile of a scheduled service, or null if it cannot be measured. */
export function profileOf(ctx: SignallingContext, s: ServiceSchedule): JourneyProfile | null {
  if (stockProblem(s.trainClass, stockOf(s)) !== null) return null;
  const plan = plansFor(ctx, s).find((p) => p.id === s.planId);
  if (!plan) return null;
  return journeyProfile(ctx, { trainClass: s.trainClass, stock: stockOf(s), plan, platform: s.platform, dwellS: s.scheduledDwellS });
}

const relCache = new WeakMap<SignallingContext, Map<string, Window[] | null>>();
const relKey = (s: ServiceSchedule): string =>
  s.ecs?.terminal ? `T|${s.trainClass}|${s.model}|${s.formation}|${s.origin}|${s.ecs.siding}|${s.ecs.onward.trainClass}|${s.ecs.onward.destination}|${s.ecs.terminal.dwellS}|${s.ecs.terminal.inboundCall?.platform ?? ''}|${s.ecs.terminal.outboundCall?.platform ?? ''}|${s.ecs.approach.join(',')}|${s.ecs.departure.join(',')}` : s.ecs ? `E|${s.model}|${s.formation}|${s.origin}|${s.ecs.siding}|${s.ecs.onward.trainClass}|${s.ecs.stablingS}|${s.ecs.approach.join(',')}|${s.ecs.departure.join(',')}` : `J|${s.trainClass}|${s.model}|${s.formation}|${s.planId}|${s.platform ?? ''}|${s.scheduledDwellS}`;

/**
 * Windows (absolute shift seconds) in which a service holds each section and point, or null if it cannot be measured.
 * The windows are measured once per kind of journey (a lone train, entering at time 0) and shifted to the entry time.
 */
export function windowsOf(ctx: SignallingContext, s: ServiceSchedule): Window[] | null {
  let m = relCache.get(ctx);
  if (!m) relCache.set(ctx, (m = new Map()));
  const key = relKey(s);
  if (!m.has(key)) {
    const zero = { ...s, entryS: 0 };
    let w: Window[] | null = null;
    if (s.ecs?.terminal) {
      const p = terminalProfileOf(ctx, zero);
      w = p ? windowsFromIntervals(ctx, zero, p.intervals) : null;
    } else if (s.ecs) {
      const p = ecsProfileOf(ctx, zero);
      w = p ? ecsResourceWindows(ctx, zero, p) : null;
    } else {
      const p = profileOf(ctx, zero);
      w = p ? resourceWindows(ctx, zero, p) : null;
    }
    m.set(key, w);
  }
  const rel = m.get(key) ?? null;
  return rel ? rel.map((w) => ({ resource: w.resource, from: w.from + s.entryS, to: w.to + s.entryS })) : null;
}

/** Conflicts between two services: [] if they can run as scheduled. `marginS` asks for more clearance than the minimum (the generator's choice). */
export function conflictsBetween(ctx: SignallingContext, a: ServiceSchedule, b: ServiceSchedule, marginS = 0): string[] {
  const wa = windowsOf(ctx, a);
  const wb = windowsOf(ctx, b);
  if (!wa || !wb) return [];
  const sep = SEPARATION_S + marginS;
  const out: string[] = [];
  if (a.origin === b.origin && Math.abs(a.entryS - b.entryS) < ENTRY_HEADWAY_S) out.push(`${a.headcode} and ${b.headcode} are scheduled to enter at ${a.origin} only ${Math.round(Math.abs(a.entryS - b.entryS))} s apart (minimum ${ENTRY_HEADWAY_S} s).`);
  const seen = new Set<string>();
  for (const x of wa) {
    for (const y of wb) {
      if (x.resource !== y.resource || seen.has(x.resource)) continue;
      if (x.from - sep < y.to && y.from - sep < x.to) {
        seen.add(x.resource);
        const platform = /section (P1|P2)$/.test(x.resource);
        out.push(`${a.headcode} and ${b.headcode} both need ${x.resource} within ${sep} s of each other${platform ? ' (the platform would be double-booked)' : ''}.`);
      }
    }
  }
  return out;
}

/** Every reason this single service is invalid. */
export function validateService(ctx: SignallingContext, s: ServiceSchedule): string[] {
  const net = ctx.net;
  const issues: string[] = [];
  const tag = s.headcode;
  if (!HEADCODE_RE.test(s.headcode)) issues.push(`${tag}: invalid headcode.`);
  if (s.headcode[0] !== String(s.trainClass)) issues.push(`${tag}: the first digit of the headcode must be the class (${s.trainClass}).`);
  if (![1, 2, 5].includes(s.trainClass)) return [...issues, `${tag}: unknown class.`];
  const stockIssue = stockProblem(s.trainClass, stockOf(s));
  if (stockIssue) return [...issues, `${tag}: ${stockIssue}`];
  const perms = permissionsFor(s.trainClass, s.model);
  const lengthM = stockPerformance(stockOf(s)).lengthM;
  if (s.ecs?.terminal) return [...issues, ...validateTerminalService(ctx, s)];
  if (s.ecs) return [...issues, ...validateEcsService(ctx, s)];

  const plan = plansFor(ctx, s).find((p) => p.id === s.planId);
  if (!plan) {
    issues.push(`${tag}: no such journey ${s.origin} → ${s.destination} for a Class ${s.trainClass} train in the network.`);
    return issues;
  }
  if (plan.path.map((p) => p.section).join('|') !== s.sections.join('|')) issues.push(`${tag}: the listed sections are not the journey's sections.`);
  if (plan.manual.join('|') !== s.manual.join('|')) issues.push(`${tag}: the movements to set do not match the journey.`);
  for (const sec of s.sections) {
    const line = net.sections.get(sec)?.line;
    if (!line || !classAllowsLine(s.trainClass, line, s.model)) issues.push(`${tag}: Class ${s.trainClass} may not use section ${sec}.`);
  }
  const entry = net.boundaries.get(s.origin);
  const exit = net.boundaries.get(s.destination);
  if (!entry?.entry) issues.push(`${tag}: ${s.origin} is not an entry.`);
  if (!exit?.exit) issues.push(`${tag}: ${s.destination} is not an exit.`);

  // station stop
  if (s.stops) {
    if (!perms.canStop) issues.push(`${tag}: Class ${s.trainClass} cannot stop.`);
    const plat = s.platform ? net.platforms.get(s.platform) : undefined;
    if (!plat) issues.push(`${tag}: a stopping train needs a platform.`);
    else {
      if (!s.sections.includes(plat.section)) issues.push(`${tag}: ${plat.name} is not reachable on its journey.`);
      const fit = platformFit(net, plat.id, lengthM);
      if (!fit.ok) issues.push(`${tag}: ${fit.reason}`);
    }
    if (s.arrivalS === null || s.departureS === null) issues.push(`${tag}: a stopping train needs scheduled arrival and departure times.`);
    if (s.minDwellS <= 0) issues.push(`${tag}: minimum dwell must be positive.`);
    if (s.scheduledDwellS < s.minDwellS) issues.push(`${tag}: scheduled dwell is shorter than the minimum dwell.`);
  } else {
    if (s.platform !== null || s.arrivalS !== null || s.departureS !== null) issues.push(`${tag}: a non-stopping train has platform or station times.`);
  }
  if (s.trainClass === 1 && !isFlexibleClass1(s.model) && (s.stops || s.platform !== null || plan.platforms.length > 0 || plan.usesBranch)) issues.push(`${tag}: a Class 1 train must run the mainline without stopping, without platforms or the branch.`);

  // timing against the measured journey
  const prof = profileOf(ctx, s);
  if (!prof) {
    issues.push(`${tag}: the journey cannot be completed by a lone train in the simulation.`);
    return issues;
  }
  if (s.entryS < 0) issues.push(`${tag}: scheduled to enter before the shift starts.`);
  if (s.stops && s.arrivalS !== null && prof.entryToArrivalS !== null && s.arrivalS < s.entryS + prof.entryToArrivalS - EPS) issues.push(`${tag}: scheduled to arrive at the platform before it can physically get there.`);
  if (s.stops && s.arrivalS !== null && s.departureS !== null && s.departureS < s.arrivalS + s.minDwellS - EPS) issues.push(`${tag}: scheduled to depart before its minimum dwell has elapsed.`);
  if (s.stops && s.departureS !== null && prof.entryToDepartureS !== null && s.departureS < s.entryS + prof.entryToDepartureS - EPS) issues.push(`${tag}: scheduled to depart before it can physically do so.`);
  if (s.exitS < s.entryS + prof.entryToExitS - EPS) issues.push(`${tag}: scheduled to exit before its journey can be completed.`);
  if (s.stops && s.departureS !== null && s.exitS <= s.departureS) issues.push(`${tag}: scheduled to exit before it has left the station.`);
  return issues;
}

/** Every reason an ECS siding cycle is invalid. */
export function validateEcsService(ctx: SignallingContext, s: ServiceSchedule): string[] {
  const net = ctx.net;
  const e = s.ecs;
  const tag = s.headcode;
  const issues: string[] = [];
  if (!e) return issues;
  if (s.trainClass !== 5) issues.push(`${tag}: only Class 5 ECS may enter the sidings.`);
  if (s.stops || s.platform !== null) issues.push(`${tag}: an ECS siding cycle does not call at a platform.`);
  const on = e.onward;
  if (!HEADCODE_RE.test(on.headcode)) issues.push(`${tag}: invalid onward headcode ${on.headcode}.`);
  else if (on.headcode[0] !== String(on.trainClass)) issues.push(`${tag}: the first digit of the onward headcode ${on.headcode} must be its class (${on.trainClass}).`);
  if (on.headcode === s.headcode) issues.push(`${tag}: the onward headcode must differ from the incoming one.`);
  if (![1, 2, 5].includes(on.trainClass)) issues.push(`${tag}: unknown onward class.`);
  else {
    const problem = stockProblem(on.trainClass, stockOf(s));
    if (problem) issues.push(`${tag}: onward service: ${problem}`);
  }
  if (e.stablingS < MIN_STABLING_S || e.stablingS > MAX_STABLING_S) issues.push(`${tag}: stabling time ${e.stablingS} s is outside ${MIN_STABLING_S}–${MAX_STABLING_S} s.`);
  const sd = net.sidings.get(e.siding);
  if (!sd) return [...issues, `${tag}: unknown siding ${e.siding}.`];
  const lengthM = stockPerformance(stockOf(s)).lengthM;
  const fit = sidingFit(net, sd.id, lengthM);
  if (!fit.ok) issues.push(`${tag}: ${fit.reason}`);
  if (!net.boundaries.get(s.origin)?.entry) issues.push(`${tag}: ${s.origin} is not an entry.`);
  const dest = net.boundaries.get(s.destination);
  if (!dest?.exit || dest.buffer) issues.push(`${tag}: ${s.destination} is not an exit.`);
  if (s.destination !== on.destination) issues.push(`${tag}: the schedule's destination must be the onward one.`);
  const plan = ecsPlanOf(ctx, s);
  if (!plan) return [...issues, `${tag}: no valid movement plan matches this cycle (${s.origin} → ${sd.name} → ${on.destination}).`];
  if (plan.arrival.bays.join('|') !== e.approachBays.join('|') || plan.departure.bays.join('|') !== e.departureBays.join('|')) issues.push(`${tag}: the listed reversal bays are not the plan's.`);
  for (const bay of [...e.approachBays, ...e.departureBays]) if (!net.reversalBays.has(bay)) issues.push(`${tag}: unknown reversal bay ${bay}.`);
  for (const m of [...e.approach, ...e.departure]) for (const sec of ctx.route(m)?.sections ?? []) if (net.sections.get(sec)?.line !== 'SIDING' && !classAllowsLine(5, net.sections.get(sec)?.line ?? 'LINK', s.model) && e.approach.includes(m)) issues.push(`${tag}: Class 5 may not use section ${sec}.`);
  const prof = ecsProfileOf(ctx, s);
  if (!prof) return [...issues, `${tag}: the cycle cannot be completed by a lone train in the simulation.`];
  if (s.entryS < 0) issues.push(`${tag}: scheduled to enter before the shift starts.`);
  if (s.arrivalS === null || s.departureS === null) return [...issues, `${tag}: an ECS cycle needs a scheduled stabled time and siding departure time.`];
  if (s.arrivalS < s.entryS + prof.entryToStabledS - EPS) issues.push(`${tag}: scheduled to be stabled before it can physically get there.`);
  if (s.departureS < s.arrivalS + e.stablingS + prof.stabledToLeavingS - EPS) issues.push(`${tag}: scheduled to leave the siding before its stabling and departure preparation can finish.`);
  if (s.exitS < s.arrivalS + e.stablingS + prof.stabledToExitS - EPS) issues.push(`${tag}: scheduled to exit before its onward journey can be completed.`);
  return issues;
}

export interface ValidationOptions {
  readonly countRange?: readonly [number, number];
}

/** Every reason the whole timetable is unacceptable. An empty list means it may be played. */
export function validateTimetable(ctx: SignallingContext, tt: Pick<Timetable, 'services'>, options: ValidationOptions = {}): string[] {
  const [lo, hi] = options.countRange ?? [MIN_SERVICES, MAX_SERVICES];
  const issues: string[] = [];
  const sv = tt.services;
  if (sv.length < lo || sv.length > hi) issues.push(`A shift needs ${lo}–${hi} services, not ${sv.length}.`);
  const codes = new Set<string>();
  for (const s of sv) {
    for (const h of headcodesOf(s)) {
      if (codes.has(h)) issues.push(`Headcode ${h} is used twice.`);
      codes.add(h);
    }
    issues.push(...validateService(ctx, s));
  }
  if (ctx.net.def.terminals && ctx.net.def.corridors) {
    // Terminus network: both corridors must carry traffic and Class 2 must run; the rest of the mix is the generator's choice.
    for (const c of ctx.net.def.corridors) if (!sv.some((s) => boundaryCorridor(ctx.net, s.origin) === c.id)) issues.push(`No service runs in the ${c.id} corridor.`);
    if (!sv.some((s) => s.trainClass === 2 || s.ecs?.onward.trainClass === 2)) issues.push('There is no Class 2 service.');
  } else {
    for (const c of [1, 2, 5]) if (!sv.some((s) => s.trainClass === c)) issues.push(`There is no Class ${c} service.`);
    if (!sv.some((s) => s.entryLine === 'UP')) issues.push('No traffic enters on the UP line.');
    if (!sv.some((s) => s.entryLine === 'DOWN')) issues.push('No traffic enters on the DOWN line.');
    if (branchServicePossible(ctx) && !sv.some((s) => s.entryLine === 'BRANCH' || s.exitLine === 'BRANCH')) issues.push('No service uses the branch although a valid branch journey exists.');
  }
  const sorted = [...sv].sort((a, b) => a.entryS - b.entryS);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) issues.push(...conflictsBetween(ctx, sorted[i] as ServiceSchedule, sorted[j] as ServiceSchedule));
  }
  return issues;
}

const branchCache = new WeakMap<SignallingContext, boolean>();
/** Does the network support any Class 2 journey that uses the branch? */
export function branchServicePossible(ctx: SignallingContext): boolean {
  let v = branchCache.get(ctx);
  if (v === undefined) {
    v = false;
    for (const o of ['N-IN', 'W-IN', 'M-IO']) for (const d of ['N-OUT', 'W-OUT', 'M-IO']) if (o !== d && (o === 'M-IO' || d === 'M-IO') && planServices(ctx, { trainClass: 2, origin: o, destination: d }).length > 0) v = true;
    branchCache.set(ctx, v);
  }
  return v;
}
