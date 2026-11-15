/**
 * Journey profiles: how long a journey takes in THIS simulation.
 *
 * Instead of guessing speeds, the profile of a journey is measured by running
 * the real train engine (`stepFleet`) once with a lone train on an empty
 * railway, with the journey's manual routes set as soon as they can be. The
 * timetable generator and validator use these figures, so scheduled times are
 * consistent with how the simulation really behaves. Results are cached.
 *
 * This is a planning measurement only. It is never used while a shift is being
 * played: during a shift the signaller sets the routes.
 */

import { checkLockInvariants, requestRoute, createSignallingState, type SignallingContext, type SignallingState } from '../signalling';
import type { StockRef } from '../rollingstock';
import { createEcsTrain, createTerminalTrain, createTrain, nextEcsMovement, nextTerminalMovement, type TerminalPlan, occupiedSteps, stepFleet, type EcsPlan, type OnwardService, type ServicePlan, type Train } from '../trains';

const DT = 0.05;
const MAX_RUN_S = 1200;

/** Sections that make up the station area: a train passing through any of them "passes Ashcombe Junction". */
export const STATION_PASS_SECTIONS: readonly string[] = ['UP8', 'DN6'];

export interface JourneyProfile {
  readonly entryToArrivalS: number | null;
  readonly entryToDepartureS: number | null;
  readonly entryToPassS: number | null;
  readonly entryToExitS: number;
  /** For each section: [front enters, rear clears], seconds after the train reached the boundary. */
  readonly sections: Readonly<Record<string, readonly [number, number]>>;
}

export interface ProfileQuery {
  readonly trainClass: number;
  /** Model and formation: a different train takes a different time over the same journey. */
  readonly stock: StockRef;
  readonly plan: ServicePlan;
  readonly platform: string | null;
  readonly dwellS: number;
}

const cache = new WeakMap<SignallingContext, Map<string, JourneyProfile | null>>();

/** The measured profile, or null if the lone train could not complete the journey. */
export function journeyProfile(ctx: SignallingContext, q: ProfileQuery): JourneyProfile | null {
  let byKey = cache.get(ctx);
  if (!byKey) cache.set(ctx, (byKey = new Map()));
  const key = `${q.trainClass}|${q.stock.model}|${q.stock.formation}|${q.plan.id}|${q.platform ?? ''}|${q.dwellS}`;
  if (!byKey.has(key)) byKey.set(key, measure(ctx, q));
  return byKey.get(key) ?? null;
}

function measure(ctx: SignallingContext, q: ProfileQuery): JourneyProfile | null {
  const first = q.plan.path[0];
  const last = q.plan.path[q.plan.path.length - 1];
  if (!first || !last) return null;
  const origin = [...ctx.net.boundaries.values()].find((b) => b.entry && b.at.section === first.section);
  const destination = [...ctx.net.boundaries.values()].find((b) => b.exit && b.at.section === last.section);
  if (!origin || !destination) return null;

  let sig: SignallingState = createSignallingState(ctx.net);
  const made = createTrain(ctx, sig, [], { headcode: '1P00', trainClass: q.trainClass, origin: origin.id, destination: destination.id, platform: q.platform, dwellS: q.dwellS, planId: q.plan.id, model: q.stock.model, formation: q.stock.formation }, 'P', { ignorePlatformAvailability: true });
  if (!made.ok) return null;
  sig = made.sig;
  let trains: Train[] = [{ ...made.train, started: true }];

  const done = new Set<string>();
  const windows: Record<string, [number, number]> = {};
  let arrival: number | null = null;
  let departure: number | null = null;
  let pass: number | null = null;
  let exit: number | null = null;
  let t0: number | null = null;
  let t = 0;
  const inside = new Set<string>();

  for (let i = 0; i * DT < MAX_RUN_S; i++) {
    const tr = trains[0] as Train;
    for (const m of q.plan.manual) {
      const r = ctx.route(m);
      if (!r || done.has(m) || sig.residual[m] || tr.heldRoutes.includes(m) || sig.routes[r.from] !== undefined) continue;
      const res = requestRoute(ctx, sig, r.from, r.to, m);
      if (res.ok) {
        sig = res.state;
        done.add(m);
      }
    }
    const step = stepFleet(ctx, sig, trains, DT);
    sig = step.sig;
    trains = [...step.trains];
    t = (i + 1) * DT;
    const now = trains[0] as Train;
    if (t0 === null && now.frontM >= 0) t0 = t;
    if (t0 !== null) {
      const rel = t - t0;
      const here = new Set(now.finished ? [] : occupiedSteps(now).map((k) => now.path[k]?.section ?? ''));
      for (const s of here) {
        if (!inside.has(s)) {
          inside.add(s);
          windows[s] = [rel, rel];
          if (pass === null && STATION_PASS_SECTIONS.includes(s)) pass = rel;
        }
        (windows[s] as [number, number])[1] = rel;
      }
      for (const s of [...inside]) if (!here.has(s)) inside.delete(s); // keep window end where it was last seen
      if (arrival === null && now.stop && (now.stop.phase === 'dwelling' || now.stop.phase === 'done' || now.stop.phase === 'departed')) arrival = rel;
      if (departure === null && arrival !== null && now.stop && (now.stop.phase === 'done' || now.stop.phase === 'departed') && now.speedMs > 0.1) departure = rel;
      if (now.finished) {
        exit = rel;
        break;
      }
    }
  }
  if (exit === null) return null;
  if (checkLockInvariants(ctx, sig).length > 0) return null;
  // A window is closed one step after the rear clears; make sure every window has a sensible end.
  return { entryToArrivalS: arrival, entryToDepartureS: departure, entryToPassS: q.platform ? null : pass, entryToExitS: exit, sections: windows };
}

// ---------------------------------------------------------------------------
// ECS siding cycles (Phase 9)
// ---------------------------------------------------------------------------

export interface EcsProfile {
  /** Seconds after the train reached the boundary at which it is fully stabled (stabling timer starts). */
  readonly entryToStabledS: number;
  /** ... and at which, with NO stabling time, its front passes the siding exit signal (it has left the siding). */
  readonly stabledToLeavingS: number;
  readonly stabledToExitS: number;
  /** Every interval each section is occupied, with zero stabling: [front enters, rear clears]. */
  readonly intervals: Readonly<Record<string, readonly (readonly [number, number])[]>>;
  /** Reversals made (bays plus the siding). */
  readonly reversals: number;
}

export interface EcsProfileQuery {
  readonly stock: StockRef;
  readonly origin: string;
  readonly siding: string;
  readonly onward: OnwardService;
  readonly plan: EcsPlan;
}

const ecsCache = new WeakMap<SignallingContext, Map<string, EcsProfile | null>>();
const MAX_ECS_RUN_S = 3000;

/** The measured profile of one ECS cycle with no stabling time (a lone train, routes set in order, like a good signaller). */
export function ecsProfile(ctx: SignallingContext, q: EcsProfileQuery): EcsProfile | null {
  let byKey = ecsCache.get(ctx);
  if (!byKey) ecsCache.set(ctx, (byKey = new Map()));
  const key = `${q.stock.model}|${q.stock.formation}|${q.onward.trainClass}|${q.plan.id}|${q.plan.arrival.movements.join(',')}|${q.plan.departure.movements.join(',')}`;
  if (!byKey.has(key)) byKey.set(key, measureEcs(ctx, q));
  return byKey.get(key) ?? null;
}

function measureEcs(ctx: SignallingContext, q: EcsProfileQuery): EcsProfile | null {
  let sig: SignallingState = createSignallingState(ctx.net);
  const made = createEcsTrain(ctx, sig, [], { headcode: '5P00', model: q.stock.model, formation: q.stock.formation, origin: q.origin, siding: q.siding, onward: { ...q.onward, headcode: `${q.onward.trainClass}P01` }, stablingS: 0, plan: q.plan }, 'P');
  if (!made.ok) return null;
  sig = made.sig;
  let trains: Train[] = [{ ...made.train, started: true }];
  const done = new Set<string>();
  const open = new Map<string, number>();
  const intervals: Record<string, [number, number][]> = {};
  let t0: number | null = null;
  let stabled: number | null = null;
  let leaving: number | null = null;
  let exit: number | null = null;
  for (let i = 0; i * DT < MAX_ECS_RUN_S; i++) {
    const tr = trains[0] as Train;
    for (let guard = 0; guard < 4; guard++) {
      const next = nextEcsMovement(ctx, sig, tr, done);
      if (!next) break;
      const r = ctx.route(next.movement);
      if (!r) return null;
      const res = requestRoute(ctx, sig, r.from, r.to, r.id);
      if (!res.ok) break;
      sig = res.state;
      done.add(next.key);
      break;
    }
    const step = stepFleet(ctx, sig, trains, DT);
    sig = step.sig;
    trains = [...step.trains];
    const now = trains[0] as Train;
    const t = (i + 1) * DT;
    if (t0 === null && now.frontM >= 0) t0 = t;
    if (t0 === null) continue;
    const rel = t - t0;
    // a section is held from the moment its route is set (reserved) until the train has cleared it: a crawl at siding speed keeps routes reserved for long
    const here = new Set(now.finished ? [] : occupiedSteps(now).map((k) => now.path[k]?.section ?? ''));
    for (const [s, owner] of Object.entries(sig.sectionLocks)) if (owner !== undefined && !now.finished) here.add(s);
    for (const s of here) if (!open.has(s)) open.set(s, rel);
    for (const [s, from] of [...open]) {
      if (!here.has(s)) {
        (intervals[s] ??= []).push([from, rel]);
        open.delete(s);
      }
    }
    const stage = now.ecs?.stage;
    if (stabled === null && stage !== undefined && stage !== 'inbound') stabled = rel;
    if (leaving === null && (stage === 'leaving' || stage === 'onward')) leaving = rel;
    if (now.finished) {
      exit = rel;
      break;
    }
  }
  if (exit === null || stabled === null || leaving === null) return null;
  if (checkLockInvariants(ctx, sig).length > 0) return null;
  return { entryToStabledS: stabled, stabledToLeavingS: leaving - stabled, stabledToExitS: exit - stabled, intervals, reversals: (trains[0] as Train).ecs?.reversals ?? 0 };
}

/** The intervals of a cycle with the real stabling time: everything after the train stabled moves later by `stablingS`, and the siding stays held through it. */
export function ecsIntervals(p: EcsProfile, stablingS: number): Record<string, [number, number][]> {
  const out: Record<string, [number, number][]> = {};
  for (const [s, list] of Object.entries(p.intervals)) {
    out[s] = list.map(([a, b]) => (a >= p.entryToStabledS ? [a + stablingS, b + stablingS] : b > p.entryToStabledS ? [a, b + stablingS] : [a, b]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Terminating cycles (Northbridge)
// ---------------------------------------------------------------------------

export interface TerminalProfile {
  /** Seconds after the train reached the boundary at which it is standing at its terminal platform. */
  readonly entryToArrivalS: number;
  /** ... at which it has changed ends and is ready to depart, and at which its front passes the departure signal. */
  readonly entryToReadyS: number;
  readonly entryToDepartureS: number;
  readonly entryToExitS: number;
  /** Optional calls at Northbridge-West: [arrival, departure] seconds after entry. */
  readonly inboundCall: readonly [number, number] | null;
  readonly outboundCall: readonly [number, number] | null;
  /** Every interval each section is occupied or reserved: [from, to], seconds after the train reached the boundary. */
  readonly intervals: Readonly<Record<string, readonly (readonly [number, number])[]>>;
}

export interface TerminalProfileQuery {
  readonly stock: StockRef;
  readonly trainClass: 1 | 2 | 5;
  readonly origin: string;
  readonly platform: string;
  readonly terminalDwellS: number;
  readonly onward: OnwardService;
  readonly inboundCall: { readonly platform: string; readonly dwellS: number } | null;
  readonly outboundCall: { readonly platform: string; readonly dwellS: number } | null;
  readonly plan: TerminalPlan;
}

const terminalCache = new WeakMap<SignallingContext, Map<string, TerminalProfile | null>>();
const MAX_TERMINAL_RUN_S = 3600;

export function terminalProfile(ctx: SignallingContext, q: TerminalProfileQuery): TerminalProfile | null {
  let byKey = terminalCache.get(ctx);
  if (!byKey) terminalCache.set(ctx, (byKey = new Map()));
  const key = [q.stock.model, q.stock.formation, q.trainClass, q.onward.trainClass, q.plan.id, q.plan.arrival.movements.join(','), q.plan.departure.movements.join(','), q.terminalDwellS, q.inboundCall?.platform ?? '', q.inboundCall?.dwellS ?? '', q.outboundCall?.platform ?? '', q.outboundCall?.dwellS ?? ''].join('|');
  if (!byKey.has(key)) byKey.set(key, measureTerminal(ctx, q));
  return byKey.get(key) ?? null;
}

function measureTerminal(ctx: SignallingContext, q: TerminalProfileQuery): TerminalProfile | null {
  let sig: SignallingState = createSignallingState(ctx.net);
  const made = createTerminalTrain(ctx, sig, [], { headcode: `${q.trainClass}P00`, trainClass: q.trainClass, model: q.stock.model, formation: q.stock.formation, origin: q.origin, platform: q.platform, terminalDwellS: q.terminalDwellS, onward: { ...q.onward, headcode: `${q.onward.trainClass}P01` }, inboundCall: q.inboundCall, outboundCall: q.outboundCall, plan: q.plan }, 'P');
  if (!made.ok) return null;
  sig = made.sig;
  let trains: Train[] = [{ ...made.train, started: true }];
  const done = new Set<string>();
  const open = new Map<string, number>();
  const intervals: Record<string, [number, number][]> = {};
  let t0: number | null = null;
  let arrival: number | null = null;
  let ready: number | null = null;
  let departure: number | null = null;
  let exit: number | null = null;
  const calls: Record<'in' | 'out', [number | null, number | null]> = { in: [null, null], out: [null, null] };
  const terminalPlatforms = new Set((ctx.net.def.terminals ?? []).map((x) => x.platform));
  for (let i = 0; i * DT < MAX_TERMINAL_RUN_S; i++) {
    const tr = trains[0] as Train;
    const next = nextTerminalMovement(ctx, sig, tr, done);
    if (next) {
      const r = ctx.route(next.movement);
      if (!r) return null;
      const res = requestRoute(ctx, sig, r.from, r.to, r.id);
      if (res.ok) {
        sig = res.state;
        done.add(next.key);
      }
    }
    const step = stepFleet(ctx, sig, trains, DT);
    sig = step.sig;
    trains = [...step.trains];
    const now = trains[0] as Train;
    const t = (i + 1) * DT;
    if (t0 === null && now.frontM >= 0) t0 = t;
    if (t0 === null) continue;
    const rel = t - t0;
    const here = new Set(now.finished ? [] : occupiedSteps(now).map((k) => now.path[k]?.section ?? ''));
    for (const [s, owner] of Object.entries(sig.sectionLocks)) if (owner !== undefined && !now.finished) here.add(s);
    for (const s of here) if (!open.has(s)) open.set(s, rel);
    for (const [s, from] of [...open]) {
      if (!here.has(s)) {
        (intervals[s] ??= []).push([from, rel]);
        open.delete(s);
      }
    }
    const st = now.stop;
    if (st && st.phase !== 'pending') {
      const slot = terminalPlatforms.has(st.platform) ? null : now.terminal?.stage === 'inbound' ? calls.in : calls.out;
      if (slot) {
        if (slot[0] === null) slot[0] = rel;
        if (st.phase === 'departed' || (st.phase === 'done' && now.speedMs > 0.1)) slot[1] ??= rel;
      } else if (arrival === null && st.phase !== 'departed') arrival = rel;
    }
    const stage = now.terminal?.stage;
    if (ready === null && (stage === 'ready' || stage === 'leaving' || stage === 'done')) ready = rel;
    if (departure === null && (stage === 'leaving' || stage === 'done')) departure = rel;
    if (now.finished) {
      exit = rel;
      break;
    }
  }
  if (exit === null || arrival === null || ready === null || departure === null) return null;
  if (checkLockInvariants(ctx, sig).length > 0) return null;
  const pair = (x: [number | null, number | null]): readonly [number, number] | null => (x[0] !== null && x[1] !== null ? [x[0], x[1]] : null);
  return { entryToArrivalS: arrival, entryToReadyS: ready, entryToDepartureS: departure, entryToExitS: exit, inboundCall: pair(calls.in), outboundCall: pair(calls.out), intervals };
}
