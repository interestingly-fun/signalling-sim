/**
 * One fixed step of one train.
 *
 *   spawnTrain  puts the train on its entry section.
 *   stepTrain   advances it by `dt` seconds, obeying the existing signalling.
 *   removeTrain takes it off the network and frees what it holds.
 *
 * SAFETY ORDER (each step)
 *  1. Aspects are computed by the Phase 2 engine from the current state.
 *  2. lookAhead finds the first Red signal / wrong point / foreign occupancy.
 *  3. The speed is held under the braking curve to that limit.
 *  4. The front is then clamped so it can NEVER reach the limit, whatever dt or
 *     speed: a train cannot pass a Red signal through an overshoot.
 *  5. Crossing a section end extends the path through nextWithPositions (the
 *     CURRENT point positions), so the train only follows points as set.
 *  6. Occupancy is written from front and rear. A route is released only when
 *     the rear has cleared its last section.
 */

import { otherEnd, type Network } from '../topology/network';
import { nextWithPositions } from '../topology/traversal';
import { computeAspects, isAutomaticMovementClear } from '../signalling/aspects';
import type { SignallingContext } from '../signalling/context';
import { detachRoute, isResidual, lockRoute, releaseCleared, unlockRoute } from '../signalling/locks';
import type { Aspect, SignallingState } from '../signalling/types';
import { permissionsFor } from './classes';
import { msToMph } from '../rollingstock/models';
import { SPEED_CONFIG, nextRestriction, permittedAt, sectionLimit, speedEnvelope, type LimitSegment } from '../speed';
import { endOf, frontSection, lastStep, occupiedSteps, rearM, startOf } from './geometry';
import { accelerationAt } from './performance';
import { lookAhead, signalAtEnd } from './lookahead';
import { platformFit } from './platforms';
import type { Limit, MovementState, OperationalStatus, PathStep, SpeedInfo, StopState, Train, TrainEvent, TrainSpec } from './types';

export interface StepResult {
  readonly sig: SignallingState;
  readonly train: Train;
  readonly events: readonly TrainEvent[];
}

export type SpawnResult =
  | { readonly ok: true; readonly sig: SignallingState; readonly train: Train }
  | { readonly ok: false; readonly reason: string };

const EPS = 1e-9;
/** Below this the train is treated as standing. */
const STANDING_MS = 0.02;

// ---------------------------------------------------------------------------
// Spawn / remove
// ---------------------------------------------------------------------------

/** A train waiting to enter stands this far outside the boundary. */
export const WAIT_OUTSIDE_M = 2;

export interface SpawnOptions {
  readonly id?: string;
  /** Movement IDs the signaller is expected to set (informational). */
  readonly plan?: readonly string[];
}

/**
 * Creates a train at its entry boundary.
 *
 *  - entrySpeedMs absent/0 (Phase 3): the front is AT the boundary on the entry
 *    section, standing, and the section is occupied from the start.
 *  - entrySpeedMs > 0 (Phase 4): the train waits just OUTSIDE the boundary. It
 *    occupies nothing until it has entered. When started it is admitted at its
 *    entry speed, provided it could still stop short of whatever is ahead.
 *
 * A requested station stop is checked here: the class must be allowed to stop,
 * and the train must fit the platform.
 */
export function spawnTrain(net: Network, sig: SignallingState, spec: TrainSpec, id = 'T1', options: SpawnOptions = {}): SpawnResult {
  const boundary = net.boundaries.get(spec.origin);
  if (!boundary || !boundary.entry) return { ok: false, reason: `${spec.origin} is not an entry to the area.` };
  const section = net.sections.get(boundary.at.section);
  if (!section) return { ok: false, reason: `Unknown section ${boundary.at.section}.` };

  let stop: StopState | null = null;
  if (spec.stop) {
    const platform = net.platforms.get(spec.stop.platform);
    if (!platform) return { ok: false, reason: `Unknown platform ${spec.stop.platform}.` };
    if (!permissionsFor(spec.trainClass, spec.stock?.model).canStop) return { ok: false, reason: `Class ${spec.trainClass} trains do not stop here.` };
    const fit = platformFit(net, platform.id, spec.lengthM);
    if (!fit.ok) return { ok: false, reason: fit.reason };
    stop = { platform: platform.id, section: platform.section, dwellS: spec.stop.dwellS, remainingS: spec.stop.dwellS, phase: 'pending' };
  }

  const waiting = (spec.entrySpeedMs ?? 0) > 0;
  if (!waiting && (sig.network.sectionOccupancy[section.id] ?? null) !== null) {
    return { ok: false, reason: `Cannot enter: section ${section.id} is occupied.` };
  }
  const train: Train = {
    id: options.id ?? id,
    spec,
    path: [{ section: section.id, enterEnd: boundary.at.end }],
    ends: [section.lengthM],
    frontM: waiting ? -WAIT_OUTSIDE_M : 0,
    speedMs: 0,
    started: false,
    exited: null,
    heldRoutes: [],
    finished: false,
    state: 'ready',
    targetSpeedMs: 0,
    limit: { kind: 'horizon', limitM: Infinity },
    holdReason: 'Ready to start',
    status: 'waiting to enter',
    stop,
    speedInfo: { permittedMs: spec.maxSpeedMs, permittedLabel: 'Model maximum', overspeed: false, next: null, envelopeMs: spec.maxSpeedMs },
    plan: options.plan ?? [],
  };
  return { ok: true, sig: writeOccupancy(sig, train), train };
}

/** Removes the train's occupancy and releases every route it still holds. */
export function removeTrain(ctx: SignallingContext, sig: SignallingState, train: Train): SignallingState {
  let next = sig;
  for (const routeId of train.heldRoutes) {
    const route = ctx.route(routeId);
    if (route && (next.routes[route.from] === routeId || isResidual(next, routeId))) next = unlockRoute(next, route);
  }
  return writeOccupancy(next, { ...train, finished: true });
}

// ---------------------------------------------------------------------------
// Occupancy
// ---------------------------------------------------------------------------

/**
 * Writes this train's occupancy. It touches only entries that are, or were,
 * its own: another train's, or a test marker, is left alone.
 */
function writeOccupancy(sig: SignallingState, train: Train): SignallingState {
  const want = new Set(train.finished ? [] : occupiedSteps(train).map((i) => train.path[i]?.section ?? ''));
  const current = sig.network.sectionOccupancy;
  const next: Record<string, string | null> = { ...current };
  let changed = false;
  for (const [section, owner] of Object.entries(current)) {
    if (owner === train.id && !want.has(section)) {
      next[section] = null;
      changed = true;
    }
  }
  for (const section of want) {
    if (next[section] !== train.id) {
      next[section] = train.id;
      changed = true;
    }
  }
  return changed ? { ...sig, network: { ...sig.network, sectionOccupancy: next } } : sig;
}

// ---------------------------------------------------------------------------
// Speed control
// ---------------------------------------------------------------------------

/** Fastest speed from which the train can still stop `gapM` ahead at the service rate. */
const curveSpeed = (brake: number, gapM: number): number => Math.sqrt(2 * brake * Math.max(0, gapM));

/** The limits of the sections the train has entered (the ones it is in, or has only just left, and the ones it has left behind). */
function pathSegments(net: Network, train: Train): LimitSegment[] {
  return train.path.map((p, i) => {
    const l = sectionLimit(net, p.section);
    return { section: p.section, startM: startOf(train, i), endM: endOf(train, i), limitMs: l.limitMs, label: l.label };
  });
}

function holdReason(limit: Limit): string {
  switch (limit.kind) {
    case 'signal':
      return `Held at signal ${limit.subject ?? ''} (Red)`;
    case 'occupied':
      return `Section ${limit.subject ?? ''} ahead is occupied`;
    case 'points':
      return 'Points ahead are not set for the line ahead';
    case 'restricted':
      return `Section ${limit.subject ?? ''} ahead is not permitted for this class of train`;
    case 'platform':
      return `Stopping at ${limit.subject ?? 'the platform'}`;
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

export function stepTrain(ctx: SignallingContext, sigIn: SignallingState, trainIn: Train, dt: number): StepResult {
  if (trainIn.finished) return { sig: sigIn, train: trainIn, events: [] };
  const net = ctx.net;
  const events: TrainEvent[] = [];
  let sig = sigIn;
  let train = trainIn;
  const spec = train.spec;

  let aspects = computeAspects(ctx, sig);
  const limit = lookAhead(net, sig, aspects, train);
  const margin = limit.marginM ?? spec.stopMarginM;

  // --- 0. admission of a train waiting outside the boundary -----------------------
  const entrySpeed = spec.entrySpeedMs ?? 0;
  if (train.started && entrySpeed > 0 && train.frontM < 0 && train.speedMs === 0) {
    const gap = limit.limitM - train.frontM;
    const canStop = !Number.isFinite(gap) || curveSpeed(spec.serviceBrakeMs2, gap - margin) >= entrySpeed;
    if (!canStop) {
      const why = limit.kind === 'occupied' ? `entry section ${limit.subject ?? ''} is occupied` : limit.kind === 'signal' ? `signal ${limit.subject ?? ''} ahead is at Danger` : 'the line ahead is not clear';
      const reason = `Waiting to enter: ${why}`;
      if (train.holdReason !== reason) events.push({ kind: 'stopped', text: `${spec.headcode} is waiting outside the boundary: ${why}.` });
      return { sig, train: { ...train, state: 'stopped', status: 'waiting to enter', limit, holdReason: reason, targetSpeedMs: 0 }, events };
    }
    train = { ...train, speedMs: entrySpeed, holdReason: '' };
    events.push({ kind: 'admitted', text: `${spec.headcode} entered the area at ${spec.origin} at ${entrySpeed.toFixed(0)} m/s.` });
  }

  // --- 1. speed under the braking curve --------------------------------------
  let v1 = train.speedMs;
  let target = 0;
  let travelled = 0;
  let protectionStop = false;
  // Speed restrictions (Phase 8): the sections entered so far and the ones the look-ahead walked through.
  const segments: LimitSegment[] = [...pathSegments(net, train), ...(limit.segments ?? [])].filter((x) => x.limitMs < spec.maxSpeedMs - 1e-9);
  const aPlan = spec.serviceBrakeMs2 * SPEED_CONFIG.brakePlanFactor;
  let envelope = spec.maxSpeedMs;
  if (train.started) {
    const gap = limit.limitM - train.frontM;
    const v = train.speedMs; // after admission
    const lineSpeed = spec.maxSpeedMs;
    if (!Number.isFinite(gap)) {
      target = lineSpeed;
      v1 = v <= lineSpeed ? Math.min(lineSpeed, v + accelerationAt(spec, v) * dt) : Math.max(lineSpeed, v - spec.serviceBrakeMs2 * dt);
    } else {
      // The braking curve: the train plans to stop `stopMarginM` short of the limit at the SERVICE rate.
      const room = gap - margin;
      target = Math.min(lineSpeed, curveSpeed(spec.serviceBrakeMs2, room));
      // Is speed `w` still one from which the train can stop at the margin after moving for this step?
      const safe = (w: number): boolean => (w * w) / (2 * spec.serviceBrakeMs2) <= room - ((v + w) / 2) * dt;
      const faster = Math.min(lineSpeed, v + accelerationAt(spec, v) * dt);
      if (safe(faster)) v1 = faster;
      else if (safe(v)) v1 = v;
      else {
        // Brake just hard enough to stop at the margin: the service rate on the planned curve, more only if the curve was violated.
        const needed = (v * v) / (2 * Math.max(room, 1e-3));
        v1 = Math.max(0, v - Math.min(spec.emergencyBrakeMs2, Math.max(needed, spec.serviceBrakeMs2)) * dt);
      }
      if (v1 < STANDING_MS && !safe(Math.min(lineSpeed, STANDING_MS + accelerationAt(spec, STANDING_MS) * dt))) v1 = 0;
    }
    // Speed restrictions: plan for the limits ahead and keep within the ones inside. The train follows the braking
    // envelope (smooth: it falls along a service-rate curve), never braking harder than the service rate for it.
    // Restrictions are not enforced for a train whose driver ignores them (test only), and never by emergency braking.
    envelope = speedEnvelope(segments, train.frontM + v * dt, spec.lengthM, aPlan, lineSpeed);
    if (!spec.ignoreRestrictions) {
      v1 = Math.min(v1, Math.max(Math.max(0, v - spec.serviceBrakeMs2 * dt), envelope));
      target = Math.min(target, envelope);
    }
    travelled = ((train.speedMs + v1) / 2) * dt;
    // Hard barrier: never reach the limit, however the numbers fall.
    if (Number.isFinite(gap) && travelled >= gap - EPS) {
      travelled = Math.max(0, gap - EPS);
      v1 = 0;
      protectionStop = train.speedMs > STANDING_MS;
    }
  }
  if (protectionStop && limit.kind === 'signal') {
    events.push({ kind: 'protection-stop', text: `${spec.headcode} stopped hard at signal ${limit.subject ?? ''}: it turned Red too close to stop smoothly.` });
  }

  // --- 2. move the front, extending the path as section ends are crossed -------
  let front = train.frontM + travelled;
  let guard = 0;
  while (train.exited === null && front > endOf(train, train.path.length - 1) + EPS && guard++ < 8) {
    const last = lastStep(train);
    const leaving = { section: last.section, end: otherEnd(last.enterEnd) };
    const signal = signalAtEnd(net, leaving);
    if (signal) {
      if ((aspects[signal.id] ?? 'red') === 'red') {
        front = endOf(train, train.path.length - 1); // defensive: must not happen, the limit stops us first
        v1 = 0;
        break;
      }
      const passed = passSignal(ctx, sig, train, signal.id, aspects);
      sig = passed.sig;
      train = passed.train;
      events.push({ kind: 'passed-signal', signal: signal.id, text: `${spec.headcode} passed signal ${signal.id}.` });
      aspects = computeAspects(ctx, sig);
    }
    const next = nextWithPositions(net, leaving, sig.network.pointPositions);
    if (!next) {
      front = endOf(train, train.path.length - 1);
      v1 = 0;
      break;
    }
    if (next.kind === 'exit') {
      train = { ...train, exited: next.boundary };
      events.push({
        kind: 'exited',
        text: next.boundary === spec.destination ? `${spec.headcode} has left the area at ${next.boundary} (its destination).` : `${spec.headcode} left the area at ${next.boundary}, not its destination ${spec.destination}.`,
      });
      break;
    }
    const occupant = sig.network.sectionOccupancy[next.enter.section] ?? null;
    if (occupant !== null && occupant !== train.id) {
      front = endOf(train, train.path.length - 1);
      v1 = 0;
      break;
    }
    const section = net.sections.get(next.enter.section);
    if (!section) break;
    const step: PathStep = { section: section.id, enterEnd: next.enter.end };
    train = { ...train, path: [...train.path, step], ends: [...train.ends, endOf(train, train.path.length - 1) + section.lengthM] };
    events.push({ kind: 'entered', section: section.id, text: `${spec.headcode} entered ${section.id}.` });
  }

  const before = occupiedSteps(train, train.frontM).map((i) => train.path[i]?.section);
  train = { ...train, frontM: front, speedMs: v1 };

  // --- 3. occupancy from front and rear ---------------------------------------
  sig = writeOccupancy(sig, train);
  const after = new Set(occupiedSteps(train).map((i) => train.path[i]?.section));
  for (const s of before) if (s && !after.has(s)) events.push({ kind: 'cleared', section: s, text: `${spec.headcode} cleared ${s}.` });

  // --- 4. sectional release: free what the REAR has cleared ------------------
  const cleared = new Set<string>();
  for (let i = 0; i < train.path.length; i++) if (rearM(train) >= endOf(train, i) - EPS) cleared.add(train.path[i]?.section ?? '');
  const kept: string[] = [];
  for (const routeId of train.heldRoutes) {
    const route = ctx.route(routeId);
    if (!route) continue;
    sig = releaseCleared(ctx, sig, route, cleared);
    if (isResidual(sig, routeId)) kept.push(routeId);
    else events.push({ kind: 'released', route: routeId, text: `Route ${route.from} → ${route.to} released: ${spec.headcode} has cleared it.` });
  }
  if (kept.length !== train.heldRoutes.length) train = { ...train, heldRoutes: kept };

  // --- 4b. station stop: arrival, dwell, ready, departed --------------------------
  let arrivedNow = false;
  if (train.stop) {
    let st = train.stop;
    const atStop = limit.kind === 'platform' && v1 < STANDING_MS && limit.limitM - margin - train.frontM <= 1.5;
    if (st.phase === 'pending' && atStop) {
      arrivedNow = true;
      st = { ...st, phase: st.dwellS > 0 ? 'dwelling' : 'done', remainingS: st.dwellS };
      events.push({ kind: 'arrived', platform: st.platform, text: `${spec.headcode} stopped at ${st.platform}.` });
      if (st.phase === 'done') events.push({ kind: 'ready', platform: st.platform, text: `${spec.headcode} is ready to depart from ${st.platform}.` });
    } else if (st.phase === 'dwelling') {
      const remaining = Math.max(0, st.remainingS - dt);
      st = remaining <= 1e-9 ? { ...st, remainingS: 0, phase: 'done' } : { ...st, remainingS: remaining };
      if (st.phase === 'done') events.push({ kind: 'ready', platform: st.platform, text: `${spec.headcode} dwell finished: ready to depart from ${st.platform}.` });
    } else if (st.phase === 'done') {
      const idx = train.path.findIndex((p) => p.section === st.section);
      if (idx >= 0 && rearM(train) >= endOf(train, idx) - EPS) {
        st = { ...st, phase: 'departed' };
        events.push({ kind: 'departed', platform: st.platform, text: `${spec.headcode} has left ${st.platform}; the platform is clear.` });
      }
    }
    if (st !== train.stop) train = { ...train, stop: st };
  }

  // --- 5. leaving the area ----------------------------------------------------
  if (train.exited !== null && rearM(train) >= endOf(train, train.path.length - 1) - EPS) {
    sig = removeTrain(ctx, sig, train);
    train = { ...train, finished: true, state: 'finished', status: 'completed', speedMs: 0, targetSpeedMs: 0, holdReason: 'Out of the area', limit: { kind: 'exit', limitM: Infinity } };
    events.push({ kind: 'finished', text: `${spec.headcode} has completely left the area.` });
    return { sig, train, events };
  }

  // --- 6. report -------------------------------------------------------------
  let state: MovementState;
  if (!train.started) state = 'ready';
  else if (v1 < STANDING_MS) state = 'stopped';
  else if (v1 < trainIn.speedMs - EPS) state = 'braking';
  else if (v1 > trainIn.speedMs + EPS) state = 'accelerating';
  else state = 'cruising';
  const st = train.stop;
  const inPlatform = st !== null && frontSection(train) === st.section;
  let status: OperationalStatus;
  let reason = '';
  if (train.exited !== null) status = 'exiting';
  else if (!train.started || (train.frontM < 0 && state === 'stopped')) status = 'waiting to enter';
  else if (st?.phase === 'dwelling') {
    status = 'dwelling';
    reason = `Dwelling at ${st.platform}`;
  } else if (state === 'stopped') {
    if (arrivedNow) status = 'stopped at platform';
    else if (st?.phase === 'done' && inPlatform) {
      status = 'ready to depart';
      reason = holdReason(limit) || 'Ready to depart';
    } else {
      status = 'stopped at signal';
      reason = holdReason(limit);
    }
  } else if (train.frontM < 0) status = 'approaching';
  else if (st?.phase === 'done' && !(rearM(train) >= endOf(train, train.path.findIndex((p) => p.section === st.section)) - EPS)) status = 'departing';
  else if (st?.phase === 'pending' && limit.kind === 'platform') status = 'approaching platform';
  else if (state === 'braking') status = 'braking';
  else status = 'running';
  if (!train.started) reason = 'Ready to start';
  if (train.started && state === 'stopped' && trainIn.state !== 'stopped' && reason && status === 'stopped at signal') events.push({ kind: 'stopped', text: `${spec.headcode} stopped. ${reason}.` });
  if (train.started && trainIn.state === 'stopped' && state !== 'stopped' && trainIn.status !== 'waiting to enter') events.push({ kind: 'moving', text: `${spec.headcode} is moving again.` });
  // --- 7. speed information and the overspeed warning (information only) ----------
  const now = permittedAt(segments, train.frontM, spec.lengthM, spec.maxSpeedMs);
  const tol = (SPEED_CONFIG.overspeedToleranceMph * 0.44704);
  const was = trainIn.speedInfo.overspeed;
  const over = v1 > now.ms + (was ? 0.1 : tol);
  if (over && !was) events.push({ kind: 'overspeed', text: `${spec.headcode} is over the speed limit: ${Math.round(msToMph(v1))} mph, permitted ${Math.round(msToMph(now.ms))} mph (${now.label}) at ${frontSection(train) ?? 'the boundary'}.` });
  if (!over && was) events.push({ kind: 'overspeed-ended', text: `${spec.headcode} is back within the permitted speed (${Math.round(msToMph(v1))} mph, permitted ${Math.round(msToMph(now.ms))} mph).` });
  const speedInfo: SpeedInfo = { permittedMs: now.ms, permittedLabel: now.label, overspeed: over, next: nextRestriction(segments, train.frontM, v1, spec.serviceBrakeMs2, now.ms), envelopeMs: envelope };
  train = { ...train, state, status, targetSpeedMs: target, limit, holdReason: reason, speedInfo };
  return { sig, train, events };
}

/**
 * The front has just passed a signal that showed a proceed aspect. Remember the
 * route it governs so that route is released only when the rear clears it.
 * A manual signal's route is already established and locked. An automatic
 * signal protects one movement that nothing has locked, so it is locked now:
 * its points and sections stay protected while the train runs over them.
 */
function passSignal(ctx: SignallingContext, sig: SignallingState, train: Train, signalId: string, aspects: Readonly<Record<string, Aspect>>): { sig: SignallingState; train: Train } {
  const signal = ctx.net.signals.get(signalId);
  if (!signal) return { sig, train };
  let routeId = sig.routes[signalId];
  if (routeId === undefined && signal.type === 'automatic') {
    const movement = ctx.from(signalId)[0];
    if (movement && (aspects[signalId] ?? 'red') !== 'red' && isAutomaticMovementClear(ctx, sig, movement)) {
      sig = lockRoute(sig, movement);
      routeId = movement.id;
    }
  }
  if (routeId === undefined || train.heldRoutes.includes(routeId)) return { sig, train };
  // The signal returns to Red behind the train. The route's locks stay, as a residual route,
  // and are freed section by section as the rear clears them.
  const route = ctx.route(routeId);
  if (route) sig = detachRoute(sig, route);
  return { sig, train: { ...train, heldRoutes: [...train.heldRoutes, routeId] } };
}
