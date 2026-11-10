/**
 * Timetable generation (Phase 5).
 *
 *  1. Choose 5–7 services with a sensible class mix (Class 1 express, Class 2
 *     regional, Class 5 empty stock), covering UP, DOWN and the branch.
 *  2. For each, choose a journey from the LOGICAL network (service planner),
 *     filtered by class rules, and a platform that journey can reach.
 *  3. Place the entry times, then work out station and exit times from the
 *     journey's MEASURED duration in the real simulation (profile.ts).
 *  4. Move any service that conflicts with an earlier one later in steps.
 *  5. Validate the whole timetable independently (validate.ts). A timetable
 *     with any issue is rejected and another attempt is made from the same
 *     seeded random stream.
 *  6. After MAX_ATTEMPTS failures use the known-safe fallback, which is also
 *     validated; if it somehow fails it is spread out until it passes.
 *
 * The same seed always produces the same timetable.
 */

import type { SignallingContext } from '../signalling';
import { isFlexibleClass1, modelsForClass, stockPerformance, type FormationDef, type ModelDef, type StockRef } from '../rollingstock';
import { permissionsFor, planServices, type ServicePlan, type TrainClassId } from '../trains';
import { journeyProfile } from './profile';
import { Rng } from './rng';
import type { LineName, ServiceSchedule, Timetable } from './types';
import { concurrencyStats } from './concurrency';
import { conflictsBetween, validateTimetable } from './validate';

export const SHIFT_START_CLOCK_S = 8 * 3600; // 08:00
export const MAX_ATTEMPTS = 60;

const ENTRIES = ['W-IN', 'N-IN', 'M-IO'] as const;
const EXITS = ['N-OUT', 'W-OUT', 'M-IO'] as const;
const MIN_DWELL: Record<number, number> = { 1: 30, 2: 30, 5: 20 };
const DWELLS: Record<number, readonly number[]> = { 1: [60, 90], 2: [60, 90, 120], 5: [60, 90] };
const LETTERS: Record<number, string> = { 1: 'AGMEOJ', 2: 'ABCDHJKL', 5: 'ZAXQ' };

const ceil10 = (n: number): number => Math.ceil(n / 10) * 10;
const round10 = (n: number): number => Math.round(n / 10) * 10;

export interface Journey {
  readonly trainClass: TrainClassId;
  readonly stock: StockRef;
  readonly origin: string;
  readonly destination: string;
  readonly platform: string | null;
  readonly plan: ServicePlan;
}

const planLength = (ctx: SignallingContext, p: ServicePlan): number => p.path.reduce((n, s) => n + (ctx.net.sections.get(s.section)?.lengthM ?? 0), 0);

const crossovers = (ctx: SignallingContext, p: ServicePlan): number => p.path.filter((s) => ctx.net.sections.get(s.section)?.line === 'CROSSOVER').length;

/**
 * Sensible plans for a journey: those that cross over the least, and among
 * them the shortest (alternatives within 25 % of the shortest). A train that
 * does not stop never takes a platform loop.
 */
export function sensiblePlans(ctx: SignallingContext, plans: ServicePlan[], platform: string | null = null): ServicePlan[] {
  const usable = platform === null ? plans.filter((p) => p.platforms.length === 0) : plans;
  if (usable.length === 0) return [];
  const fewest = Math.min(...usable.map((p) => crossovers(ctx, p)));
  const pool = usable.filter((p) => crossovers(ctx, p) === fewest);
  const shortest = Math.min(...pool.map((p) => planLength(ctx, p)));
  return pool.filter((p) => planLength(ctx, p) <= shortest * 1.25).sort((a, b) => a.id.localeCompare(b.id));
}

/** All journeys a class working with this rolling stock can make in this network. */
export function journeyOptions(ctx: SignallingContext, trainClass: TrainClassId, stock: StockRef): Journey[] {
  const out: Journey[] = [];
  const perms = permissionsFor(trainClass, stock.model);
  const lengthM = stockPerformance(stock).lengthM;
  for (const origin of ENTRIES) {
    for (const destination of EXITS) {
      if (origin === destination) continue;
      const base = { trainClass, origin, destination, lengthM, model: stock.model };
      for (const plan of sensiblePlans(ctx, planServices(ctx, base), null)) out.push({ trainClass, stock, origin, destination, platform: null, plan });
      if (perms.canStop) {
        for (const platform of ctx.net.platforms.values()) {
          for (const plan of sensiblePlans(ctx, planServices(ctx, { ...base, platform: platform.id }), platform.id)) out.push({ trainClass, stock, origin, destination, platform: platform.id, plan });
        }
      }
    }
  }
  return out;
}

const pickWeighted = <T extends { readonly weight: number }>(rng: Rng, items: readonly T[]): T => {
  let r = rng.next() * items.reduce((n, i) => n + i.weight, 0);
  for (const i of items) {
    r -= i.weight;
    if (r < 0) return i;
  }
  return items[items.length - 1] as T;
};

/**
 * A model and formation for an operating class, chosen by the weights in the rolling-stock database from the
 * models permitted to work that class. Uses its own random stream so it never disturbs the choice of journeys.
 */
export function pickStock(rng: Rng, trainClass: number): StockRef {
  const model: ModelDef = pickWeighted(rng, modelsForClass(trainClass));
  const formation: FormationDef = pickWeighted(rng, model.formations);
  return { model: model.id, formation: formation.id };
}

const lineOf = (ctx: SignallingContext, section: string | undefined): LineName => {
  const l = ctx.net.sections.get(section ?? '')?.line;
  return l === 'DOWN' ? 'DOWN' : l === 'BRANCH' ? 'BRANCH' : 'UP';
};

/** Builds a fully timed service from a journey and an entry time. Returns null if the journey cannot be measured. */
export function buildService(ctx: SignallingContext, j: Journey, headcode: string, entryS: number, scheduledDwellS: number): ServiceSchedule | null {
  const stops = j.platform !== null;
  const dwell = stops ? scheduledDwellS : 0;
  const prof = journeyProfile(ctx, { trainClass: j.trainClass, stock: j.stock, plan: j.plan, platform: j.platform, dwellS: dwell });
  if (!prof) return null;
  const arrivalS = stops && prof.entryToArrivalS !== null ? entryS + ceil10(prof.entryToArrivalS) : null;
  const departureS = arrivalS !== null ? arrivalS + dwell : null;
  const passS = !stops && prof.entryToPassS !== null ? entryS + ceil10(prof.entryToPassS) : null;
  const first = j.plan.path[0]?.section;
  const last = j.plan.path[j.plan.path.length - 1]?.section;
  return {
    id: headcode,
    headcode,
    trainClass: j.trainClass,
    model: j.stock.model,
    formation: j.stock.formation,
    origin: j.origin,
    destination: j.destination,
    entryLine: lineOf(ctx, first),
    exitLine: lineOf(ctx, last),
    planId: j.plan.id,
    routeLabel: j.plan.label,
    sections: j.plan.path.map((p) => p.section),
    manual: j.plan.manual,
    stops,
    platform: j.platform,
    minDwellS: stops ? (MIN_DWELL[j.trainClass] ?? 30) : 0,
    scheduledDwellS: dwell,
    entryS,
    arrivalS,
    departureS,
    passS,
    exitS: entryS + ceil10(prof.entryToExitS),
  };
}

function makeHeadcode(rng: Rng, trainClass: number, used: Set<string>): string {
  for (let i = 0; i < 500; i++) {
    const h = `${trainClass}${rng.pick([...(LETTERS[trainClass] ?? 'A')])}${rng.int(10, 99)}`;
    if (!used.has(h)) {
      used.add(h);
      return h;
    }
  }
  throw new Error('headcode pool exhausted');
}

const MIXES: readonly (readonly [number, number, number])[] = [
  [2, 2, 1], // n = 5
  [2, 3, 1],
  [3, 2, 1], // n = 6
  [2, 2, 2],
  [3, 3, 1],
  [3, 2, 2], // n = 7
  [2, 3, 2],
];

function attempt(ctx: SignallingContext, rng: Rng, stockRng: Rng, options: Options): ServiceSchedule[] | null {
  const n = rng.int(5, 7);
  const mix = rng.pick(MIXES.filter((m) => m[0] + m[1] + m[2] === n));
  const classes: TrainClassId[] = rng.shuffle([...Array(mix[0]).fill(1), ...Array(mix[1]).fill(2), ...Array(mix[2]).fill(5)] as TrainClassId[]);

  // each service gets its rolling stock first; the stock decides what journeys it may be given
  const stocks: StockRef[] = classes.map((c) => pickStock(stockRng, c));
  const optionCache = new Map<string, Journey[]>();
  const optionsFor = (i: number): Journey[] => {
    const c = classes[i] as TrainClassId;
    const stock = stocks[i] as StockRef;
    const key = `${c}|${stock.model}|${stock.formation}`;
    let o = optionCache.get(key);
    if (!o) optionCache.set(key, (o = journeyOptions(ctx, c, stock)));
    return o;
  };
  const wantStop = (c: number, stock: StockRef): boolean => (c === 2 ? rng.next() < 0.8 : c === 5 ? rng.next() < 0.35 : isFlexibleClass1(stock.model) ? rng.next() < 0.5 : false);
  const choose = (i: number, filter: (j: Journey) => boolean, stop: boolean): Journey | null => {
    let pool = optionsFor(i).filter(filter);
    const stopPool = pool.filter((j) => (j.platform !== null) === stop);
    if (stopPool.length > 0) pool = stopPool;
    return pool.length > 0 ? rng.pick(pool) : null;
  };

  // coverage: one branch service (a Class 2 where possible), one UP and one DOWN entry among the rest
  const chosen: (Journey | null)[] = classes.map(() => null);
  const firstTwo = classes.findIndex((c) => c === 2);
  if (firstTwo >= 0) chosen[firstTwo] = choose(firstTwo, (j) => j.origin === 'M-IO' || j.destination === 'M-IO', wantStop(2, stocks[firstTwo] as StockRef));
  const order = rng.shuffle(classes.map((_, i) => i).filter((i) => i !== firstTwo));
  const needs = ['W-IN', 'N-IN'];
  order.forEach((i, k) => {
    const c = classes[i] as TrainClassId;
    const need = needs[k];
    const stop = wantStop(c, stocks[i] as StockRef);
    chosen[i] = choose(i, (j) => (need ? j.origin === need : true), stop) ?? choose(i, () => true, stop);
  });
  if (chosen.some((j) => j === null)) return null;

  // entry times
  const sequence = rng.shuffle(classes.map((_, i) => i));
  const used = new Set<string>();
  const placed: ServiceSchedule[] = [];
  const [minGap, maxGap] = GAPS[options.pattern];
  let t = round10(rng.int(30, 120));
  for (const i of sequence) {
    const j = chosen[i] as Journey;
    const headcode = makeHeadcode(rng, j.trainClass, used);
    const dwell = j.platform ? rng.pick(DWELLS[j.trainClass] ?? [60]) : 0;
    let svc: ServiceSchedule | null = null;
    for (let k = 0; k < 150; k++) {
      svc = buildService(ctx, j, headcode, t + k * 10, dwell);
      if (!svc) return null;
      if (!placed.some((p) => conflictsBetween(ctx, p, svc as ServiceSchedule).length > 0)) break;
      svc = null;
    }
    if (!svc) return null;
    placed.push(svc);
    t = round10(svc.entryS + rng.int(minGap, maxGap));
  }
  return placed.sort((a, b) => a.entryS - b.entryS);
}

/**
 * How busy a shift is meant to be (Phase 8). The gap between one service entering and the next is drawn from a range;
 * a short range makes services overlap in the area. Each service is then placed at the earliest time at which it does not
 * conflict with the ones already placed, so overlap happens only where the infrastructure allows it.
 */
export type Pattern = 'busy' | 'normal' | 'quiet';
const GAPS: Record<Pattern, readonly [number, number]> = { busy: [10, 100], normal: [40, 170], quiet: [150, 330] };
/** The most services that should be present at once for this pattern (a target, relaxed if it cannot be met). */
const TARGET: Record<Pattern, number> = { busy: 3, normal: 2, quiet: 1 };

function pickPattern(rng: Rng): Pattern {
  const r = rng.next();
  return r < 0.35 ? 'busy' : r < 0.85 ? 'normal' : 'quiet';
}

interface Options {
  readonly pattern: Pattern;
  readonly maxAttempts: number;
}

const finish = (services: ServiceSchedule[], seed: number, usedFallback: boolean, attempts: number, rejected: string[]): Timetable => ({
  seed,
  startClockS: SHIFT_START_CLOCK_S,
  services,
  endS: Math.max(...services.map((s) => s.exitS)),
  usedFallback,
  attempts,
  rejected,
});

export interface GenerateOptions {
  /** Attempts before the fallback is used (default MAX_ATTEMPTS). 0 forces the fallback. */
  readonly maxAttempts?: number;
}

/** A playable, validated timetable for this seed. Never throws for a normal network. */
export function generateTimetable(ctx: SignallingContext, seed: number, options: GenerateOptions = {}): Timetable {
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const rng = new Rng(seed * 2654435761 + 12345);
  const stockRng = new Rng(seed * 40503 + 977);
  const rejected: string[] = [];
  const pattern = pickPattern(rng);
  for (let a = 1; a <= maxAttempts; a++) {
    const services = attempt(ctx, rng, stockRng, { pattern, maxAttempts });
    if (!services) {
      rejected.push(`attempt ${a}: no valid set of journeys`);
      continue;
    }
    const issues = validateTimetable(ctx, { services });
    if (issues.length > 0) {
      rejected.push(`attempt ${a}: ${issues[0]}`);
      continue;
    }
    // Aim for the pattern's amount of overlap; if many attempts cannot manage it, accept less (never invent an unsafe overlap).
    const want = a <= maxAttempts / 2 ? TARGET[pattern] : Math.min(TARGET[pattern], a <= (maxAttempts * 3) / 4 ? 2 : 1);
    if (concurrencyStats(services).maxPresent < want) {
      rejected.push(`attempt ${a}: only ${concurrencyStats(services).maxPresent} train(s) ever present together (wanted ${want})`);
      continue;
    }
    return finish(services, seed, false, a, rejected);
  }
  return fallbackTimetable(ctx, seed, maxAttempts, rejected);
}

interface FallbackDef {
  readonly headcode: string;
  readonly trainClass: TrainClassId;
  readonly stock: StockRef;
  readonly origin: string;
  readonly destination: string;
  readonly platform: string | null;
  readonly dwellS: number;
  readonly entryS: number;
}

/** Known-good services. They overlap on purpose (an UP and a DOWN train together, a platform stop beside independent traffic, a branch train), so the fallback is not a one-train-at-a-time shift. */
const FALLBACK: readonly FallbackDef[] = [
  { headcode: '5A12', trainClass: 5, stock: { model: '150', formation: '2-car' }, origin: 'W-IN', destination: 'N-OUT', platform: null, dwellS: 0, entryS: 60 },
  { headcode: '1G42', trainClass: 1, stock: { model: '800', formation: '9-car' }, origin: 'N-IN', destination: 'W-OUT', platform: null, dwellS: 0, entryS: 100 },
  { headcode: '2A17', trainClass: 2, stock: { model: '170', formation: '2-car' }, origin: 'W-IN', destination: 'N-OUT', platform: 'PLAT1', dwellS: 90, entryS: 330 },
  { headcode: '2B64', trainClass: 2, stock: { model: '175', formation: '3-car' }, origin: 'N-IN', destination: 'W-OUT', platform: 'PLAT2', dwellS: 90, entryS: 420 },
  { headcode: '2M21', trainClass: 2, stock: { model: '387', formation: '4-car' }, origin: 'M-IO', destination: 'N-OUT', platform: null, dwellS: 0, entryS: 660 },
  { headcode: '1A35', trainClass: 1, stock: { model: '390', formation: '9-car' }, origin: 'W-IN', destination: 'N-OUT', platform: null, dwellS: 0, entryS: 620 },
];

/** The known-safe timetable: fixed, overlapping services, validated like any other. Spread out (later) only if validation fails, which it should not. */
export function fallbackTimetable(ctx: SignallingContext, seed = 0, attempts = 0, rejected: string[] = []): Timetable {
  for (let spread = 1; spread <= 6; spread += 0.5) {
    const services: ServiceSchedule[] = [];
    for (const d of FALLBACK) {
      const plans = sensiblePlans(ctx, planServices(ctx, { trainClass: d.trainClass, origin: d.origin, destination: d.destination, platform: d.platform, lengthM: stockPerformance(d.stock).lengthM, model: d.stock.model }), d.platform);
      const plan = plans[0];
      if (!plan) continue;
      const svc = buildService(ctx, { trainClass: d.trainClass, stock: d.stock, origin: d.origin, destination: d.destination, platform: d.platform, plan }, d.headcode, round10(d.entryS * spread), d.dwellS);
      if (svc) services.push(svc);
    }
    if (validateTimetable(ctx, { services }).length === 0) return finish(services, seed, true, attempts, rejected);
  }
  throw new Error('The fallback timetable is invalid: the network has changed.');
}
