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
import { createTrain, occupiedSteps, stepFleet, type ServicePlan, type Train } from '../trains';

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
  readonly plan: ServicePlan;
  readonly platform: string | null;
  readonly dwellS: number;
}

const cache = new WeakMap<SignallingContext, Map<string, JourneyProfile | null>>();

/** The measured profile, or null if the lone train could not complete the journey. */
export function journeyProfile(ctx: SignallingContext, q: ProfileQuery): JourneyProfile | null {
  let byKey = cache.get(ctx);
  if (!byKey) cache.set(ctx, (byKey = new Map()));
  const key = `${q.trainClass}|${q.plan.id}|${q.platform ?? ''}|${q.dwellS}`;
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
  const made = createTrain(ctx, sig, [], { headcode: '1P00', trainClass: q.trainClass, origin: origin.id, destination: destination.id, platform: q.platform, dwellS: q.dwellS, planId: q.plan.id }, 'P', { ignorePlatformAvailability: true });
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
