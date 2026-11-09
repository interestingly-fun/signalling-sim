/**
 * Many trains, one simulation (Phase 4).
 *
 * There is ONE movement implementation, `stepTrain`. A fleet is just a list of
 * trains stepped one after another against the same signalling state, so every
 * train sees the occupancy, locks and aspects the previous one left. Trains
 * share no state except the signalling state.
 */

import type { SignallingContext } from '../signalling/context';
import type { SignallingState } from '../signalling/types';
import { classProfile, specForClass, TRAIN_CLASSES, type TrainClassId } from './classes';
import { planServices, type ServicePlan } from './planner';
import { platformFit } from './platforms';
import { removeTrain, spawnTrain, stepTrain } from './step';
import type { Train, TrainEvent, TrainSpec } from './types';

export interface FleetStep {
  readonly sig: SignallingState;
  readonly trains: readonly Train[];
  readonly events: readonly TrainEvent[];
}

/** Advances every started, unfinished train by one fixed step. Trains not yet started stand still. */
export function stepFleet(ctx: SignallingContext, sigIn: SignallingState, trains: readonly Train[], dt: number): FleetStep {
  let sig = sigIn;
  const events: TrainEvent[] = [];
  const out = trains.map((t) => {
    if (t.finished || !t.started) return t;
    const r = stepTrain(ctx, sig, t, dt);
    sig = r.sig;
    events.push(...r.events);
    return r.train;
  });
  return { sig, trains: out, events };
}

/** Everything the operator chooses when creating a train. */
export interface TrainRequest {
  readonly headcode: string;
  readonly trainClass: number;
  readonly origin: string;
  readonly destination: string;
  /** Station stop: platform ID, or null/undefined to run through. */
  readonly platform?: string | null;
  readonly dwellS?: number;
  /** Plan ID (from planServices). Omitted: the first valid plan. */
  readonly planId?: string;
}

export type CreateResult =
  | { readonly ok: true; readonly sig: SignallingState; readonly train: Train; readonly plan: ServicePlan }
  | { readonly ok: false; readonly reason: string };

export const MAX_DWELL_S = 600;

/** Platforms another live train is already due to use (assigned and not yet departed). */
export function assignedPlatforms(trains: readonly Train[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of trains) if (!t.finished && t.stop && t.stop.phase !== 'departed') m.set(t.stop.platform, t.spec.headcode);
  return m;
}

/** Why this platform cannot be offered right now, or null. */
export function platformUnavailable(ctx: SignallingContext, sig: SignallingState, trains: readonly Train[], platformId: string): string | null {
  const p = ctx.net.platforms.get(platformId);
  if (!p) return `Unknown platform ${platformId}.`;
  const occupant = sig.network.sectionOccupancy[p.section] ?? null;
  if (occupant !== null) return `${p.name} is occupied.`;
  const other = assignedPlatforms(trains).get(platformId);
  if (other) return `${p.name} is already assigned to ${other}.`;
  return null;
}

/**
 * Platforms a train of this class could call at on this journey: reachable by
 * a legal path, long enough, unoccupied and not assigned to another train.
 */
export function platformOptions(
  ctx: SignallingContext,
  sig: SignallingState,
  trains: readonly Train[],
  q: { trainClass: number; origin: string; destination: string; lengthM?: number },
): { id: string; name: string }[] {
  if (!classProfile(q.trainClass).canStop) return [];
  const out: { id: string; name: string }[] = [];
  for (const p of ctx.net.platforms.values()) {
    if (platformUnavailable(ctx, sig, trains, p.id) !== null) continue;
    if (q.lengthM !== undefined && !platformFit(ctx.net, p.id, q.lengthM).ok) continue;
    if (planServices(ctx, { ...q, platform: p.id }).length === 0) continue;
    out.push({ id: p.id, name: p.name });
  }
  return out;
}

/** Validates a request and creates the train waiting outside its boundary. Nothing is set or moved. */
export interface CreateOptions {
  /**
   * Scheduled services (Phase 5): do not refuse because the platform is occupied or assigned to another
   * train right now. The train waits outside or at a signal like any other; the interlocking decides.
   */
  readonly ignorePlatformAvailability?: boolean;
}

export function createTrain(ctx: SignallingContext, sig: SignallingState, existing: readonly Train[], req: TrainRequest, id: string, options: CreateOptions = {}): CreateResult {
  const headcode = req.headcode.trim().toUpperCase();
  if (!/^[0-9][A-Z][0-9]{2}$/.test(headcode)) return { ok: false, reason: `Headcode "${req.headcode}" is not valid: use a digit, a letter and two digits, e.g. 2A01.` };
  if (existing.some((t) => !t.finished && t.spec.headcode === headcode)) return { ok: false, reason: `Headcode ${headcode} is already in use.` };
  if (!TRAIN_CLASSES.includes(req.trainClass as TrainClassId)) return { ok: false, reason: `Unknown train class ${req.trainClass}.` };
  const cls = req.trainClass as TrainClassId;
  const profile = classProfile(cls);
  const wantsStop = req.platform !== null && req.platform !== undefined && req.platform !== '';
  if (wantsStop && !profile.canStop) return { ok: false, reason: `Class ${cls} (${profile.name}) trains never stop at a platform.` };
  const dwellS = req.dwellS ?? profile.defaultDwellS;
  if (!Number.isFinite(dwellS) || dwellS < 0 || dwellS > MAX_DWELL_S) return { ok: false, reason: `Dwell time must be between 0 and ${MAX_DWELL_S} seconds.` };

  if (wantsStop && !options.ignorePlatformAvailability) {
    const why = platformUnavailable(ctx, sig, existing, req.platform as string);
    if (why) return { ok: false, reason: why };
  }
  const plans = planServices(ctx, { trainClass: cls, origin: req.origin, destination: req.destination, platform: wantsStop ? req.platform : null, lengthM: profile.lengthM });
  if (plans.length === 0) {
    const branch = [req.origin, req.destination].includes('M-IO');
    return {
      ok: false,
      reason:
        cls === 1 && branch
          ? 'Class 1 expresses never use the branch.'
          : wantsStop
            ? `No valid route from ${req.origin} to ${req.destination} calls at that platform for a Class ${cls} train.`
            : `No valid route from ${req.origin} to ${req.destination} for a Class ${cls} train.`,
    };
  }
  const plan = req.planId ? plans.find((p) => p.id === req.planId) : plans[0];
  if (!plan) return { ok: false, reason: 'That route is not valid for this train.' };

  const spec: TrainSpec = specForClass(cls, {
    headcode,
    origin: req.origin,
    destination: req.destination,
    stop: wantsStop ? { platform: req.platform as string, dwellS } : null,
  });
  const sp = spawnTrain(ctx.net, sig, spec, id, { id, plan: plan.movements });
  if (!sp.ok) return { ok: false, reason: sp.reason };
  return { ok: true, sig: sp.sig, train: sp.train, plan };
}

/** Removes a train that has not yet entered the area (it holds nothing, so nothing is released). */
export function canRemoveUnentered(t: Train): boolean {
  return !t.finished && t.frontM < 0 && t.path.length === 1;
}

/** Removes every train and frees what they hold. */
export function removeAll(ctx: SignallingContext, sig: SignallingState, trains: readonly Train[]): SignallingState {
  let s = sig;
  for (const t of trains) s = removeTrain(ctx, s, t);
  return s;
}
