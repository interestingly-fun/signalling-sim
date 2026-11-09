/**
 * Timetable validation (Phase 5). Independent of the generator: it re-derives
 * everything from the logical network and the measured journey profiles, so a
 * timetable from any source (generator, fallback, hand-written) is checked the
 * same way. A timetable with ANY issue is never accepted.
 */

import type { SignallingContext } from '../signalling';
import { CLASS_PROFILES, classAllowsLine, platformFit, planServices, type TrainClassId } from '../trains';
import { journeyProfile, type JourneyProfile } from './profile';
import type { ServiceSchedule, Timetable } from './types';

/** Two services may not use the same section or point within this many seconds of each other. */
export const SEPARATION_S = 45;
/** Two trains entering at the same boundary must be at least this far apart. */
export const ENTRY_HEADWAY_S = 150;
export const MIN_SERVICES = 5;
export const MAX_SERVICES = 7;
const EPS = 1.5;

export const HEADCODE_RE = /^[0-9][A-Z][0-9]{2}$/;

interface Window {
  readonly resource: string;
  readonly from: number;
  readonly to: number;
}

/** Windows (absolute shift seconds) in which a service holds each section and each point. */
export function resourceWindows(ctx: SignallingContext, s: ServiceSchedule, profile: JourneyProfile): Window[] {
  const out: Window[] = [];
  const secs = profile.sections;
  for (const [sec, [a, b]] of Object.entries(secs)) out.push({ resource: `section ${sec}`, from: s.entryS + a, to: s.entryS + b });
  for (const p of ctx.net.points.values()) {
    const touched = [p.toe.section, p.normal.section, p.reverse.section].filter((x) => secs[x] !== undefined);
    if (touched.length < 2) continue; // the service does not run through this point
    const from = Math.min(...touched.map((x) => (secs[x] as readonly [number, number])[0]));
    const to = Math.max(...touched.map((x) => (secs[x] as readonly [number, number])[1]));
    out.push({ resource: `point ${p.id}`, from: s.entryS + from, to: s.entryS + to });
  }
  return out;
}

/** Profile of a scheduled service, or null if it cannot be measured. */
export function profileOf(ctx: SignallingContext, s: ServiceSchedule): JourneyProfile | null {
  const plan = planServices(ctx, { trainClass: s.trainClass, origin: s.origin, destination: s.destination, platform: s.platform, lengthM: CLASS_PROFILES[s.trainClass].lengthM }).find((p) => p.id === s.planId);
  if (!plan) return null;
  return journeyProfile(ctx, { trainClass: s.trainClass, plan, platform: s.platform, dwellS: s.scheduledDwellS });
}

/** Conflicts between two services: [] if they can run as scheduled. */
export function conflictsBetween(ctx: SignallingContext, a: ServiceSchedule, b: ServiceSchedule): string[] {
  const pa = profileOf(ctx, a);
  const pb = profileOf(ctx, b);
  if (!pa || !pb) return [];
  const out: string[] = [];
  if (a.origin === b.origin && Math.abs(a.entryS - b.entryS) < ENTRY_HEADWAY_S) out.push(`${a.headcode} and ${b.headcode} are scheduled to enter at ${a.origin} only ${Math.round(Math.abs(a.entryS - b.entryS))} s apart (minimum ${ENTRY_HEADWAY_S} s).`);
  const wb = resourceWindows(ctx, b, pb);
  const seen = new Set<string>();
  for (const x of resourceWindows(ctx, a, pa)) {
    for (const y of wb) {
      if (x.resource !== y.resource || seen.has(x.resource)) continue;
      if (x.from - SEPARATION_S < y.to && y.from - SEPARATION_S < x.to) {
        seen.add(x.resource);
        const platform = /section (P1|P2)$/.test(x.resource);
        out.push(`${a.headcode} and ${b.headcode} both need ${x.resource} within ${SEPARATION_S} s of each other${platform ? ' (the platform would be double-booked)' : ''}.`);
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
  const profile = CLASS_PROFILES[s.trainClass as TrainClassId];

  const plan = planServices(ctx, { trainClass: s.trainClass, origin: s.origin, destination: s.destination, platform: s.platform, lengthM: profile.lengthM }).find((p) => p.id === s.planId);
  if (!plan) {
    issues.push(`${tag}: no such journey ${s.origin} → ${s.destination} for a Class ${s.trainClass} train in the network.`);
    return issues;
  }
  if (plan.path.map((p) => p.section).join('|') !== s.sections.join('|')) issues.push(`${tag}: the listed sections are not the journey's sections.`);
  if (plan.manual.join('|') !== s.manual.join('|')) issues.push(`${tag}: the movements to set do not match the journey.`);
  for (const sec of s.sections) {
    const line = net.sections.get(sec)?.line;
    if (!line || !classAllowsLine(s.trainClass, line)) issues.push(`${tag}: Class ${s.trainClass} may not use section ${sec}.`);
  }
  const entry = net.boundaries.get(s.origin);
  const exit = net.boundaries.get(s.destination);
  if (!entry?.entry) issues.push(`${tag}: ${s.origin} is not an entry.`);
  if (!exit?.exit) issues.push(`${tag}: ${s.destination} is not an exit.`);

  // station stop
  if (s.stops) {
    if (!profile.canStop) issues.push(`${tag}: Class ${s.trainClass} cannot stop.`);
    const plat = s.platform ? net.platforms.get(s.platform) : undefined;
    if (!plat) issues.push(`${tag}: a stopping train needs a platform.`);
    else {
      if (!s.sections.includes(plat.section)) issues.push(`${tag}: ${plat.name} is not reachable on its journey.`);
      const fit = platformFit(net, plat.id, profile.lengthM);
      if (!fit.ok) issues.push(`${tag}: ${fit.reason}`);
    }
    if (s.arrivalS === null || s.departureS === null) issues.push(`${tag}: a stopping train needs scheduled arrival and departure times.`);
    if (s.minDwellS <= 0) issues.push(`${tag}: minimum dwell must be positive.`);
    if (s.scheduledDwellS < s.minDwellS) issues.push(`${tag}: scheduled dwell is shorter than the minimum dwell.`);
  } else {
    if (s.platform !== null || s.arrivalS !== null || s.departureS !== null) issues.push(`${tag}: a non-stopping train has platform or station times.`);
  }
  if (s.trainClass === 1 && (s.stops || s.platform !== null || plan.platforms.length > 0 || plan.usesBranch)) issues.push(`${tag}: a Class 1 train must run the mainline without stopping, without platforms or the branch.`);

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
    if (codes.has(s.headcode)) issues.push(`Headcode ${s.headcode} is used twice.`);
    codes.add(s.headcode);
    issues.push(...validateService(ctx, s));
  }
  for (const c of [1, 2, 5]) if (!sv.some((s) => s.trainClass === c)) issues.push(`There is no Class ${c} service.`);
  if (!sv.some((s) => s.entryLine === 'UP')) issues.push('No traffic enters on the UP line.');
  if (!sv.some((s) => s.entryLine === 'DOWN')) issues.push('No traffic enters on the DOWN line.');
  if (branchServicePossible(ctx) && !sv.some((s) => s.entryLine === 'BRANCH' || s.exitLine === 'BRANCH')) issues.push('No service uses the branch although a valid branch journey exists.');
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
