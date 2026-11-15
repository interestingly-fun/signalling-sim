/**
 * Timetable generation (Phase 5, reworked in Phase 10).
 *
 *  1. The difficulty profile (difficulty.ts) gives a target service count and how hard to push overlap.
 *  2. A seeded RNG picks the services: class mix, UP/DOWN/BRANCH origins and destinations, stock, platform
 *     and, within limits, ECS siding cycles (never last or second-to-last).
 *  3. Each service's lone-train duration is MEASURED with the real simulation (profile.ts, cached).
 *  4. The planner places services one at a time over an occupancy index of section/point/siding windows.
 *     Candidate entry times (10 s steps) are scored for deliberate overlap and useful interactions
 *     (opposing, express/local, branch/main, ECS/passenger, junction sequencing); a candidate with any
 *     conflict inside the validator's margin plus the difficulty's extra margin is refused outright, so
 *     independent movements overlap freely and conflicting ones keep real clearance. No artificial delays.
 *  4. If the railway cannot hold the requested count safely, fewer services are produced and the reason is
 *     recorded in the GenerationReport.
 *  5. The whole timetable is validated independently (validate.ts); a failing attempt is rejected and retried
 *     from the same seeded stream. After MAX_ATTEMPTS the known-safe fallback is used.
 *
 * The same seed and difficulty always produce the same timetable.
 */

import type { SignallingContext } from '../signalling';
import { getModel, isFlexibleClass1, modelsForClass, stockPerformance, type FormationDef, type ModelDef, type StockRef } from '../rollingstock';
import { permissionsFor, planEcsCycles, planServices, sidingFit, type EcsPlan, type ServicePlan, type TrainClassId } from '../trains';
import { ecsProfile, journeyProfile } from './profile';
import { Rng } from './rng';
import { generateTerminusTimetable } from './generateTerminus';
import type { EcsSchedule, LineName, ServiceSchedule, Timetable } from './types';
import { concurrencyStats } from './concurrency';
import { analyseTraffic, interactionKinds } from './analysis';
import { DEFAULT_DIFFICULTY, difficultyProfile, type DifficultyId, type DifficultyProfile } from './difficulty';
import { ENTRY_HEADWAY_S, MIN_SERVICES, SEPARATION_S, validateTimetable, windowsOf, type Window } from './validate';

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

// ---------------------------------------------------------------------------
// ECS siding cycles (Phase 9)
// ---------------------------------------------------------------------------

const STABLING_CHOICES: readonly number[] = [180, 240, 300, 420, 540, 720];
const ECS_STOP_MARGIN_M = 12;

/** A chosen ECS cycle, before it is timed. */
export interface EcsChoice {
  readonly stock: StockRef;
  readonly origin: string;
  readonly siding: string;
  readonly onwardClass: 1 | 2 | 5;
  readonly destination: string;
  readonly stablingS: number;
  readonly plan: EcsPlan;
}

/** Classes a model may work after the siding (1, 2 or 5) that its rolling-stock entry permits. */
export function onwardClasses(stock: StockRef): (1 | 2 | 5)[] {
  const m = getModel(stock.model);
  return m ? ([...m.classes.filter((c) => c === 1 || c === 2), 5] as (1 | 2 | 5)[]) : [5];
}

/**
 * Every valid ECS cycle for this rolling stock: each entry, siding that holds the train, onward class and exit for which
 * the planner finds a complete chain of valid movements (so nothing impossible is ever offered).
 */
export function ecsOptions(ctx: SignallingContext, stock: StockRef): EcsChoice[] {
  const out: EcsChoice[] = [];
  const lengthM = stockPerformance(stock).lengthM;
  for (const siding of ctx.net.sidings.values()) {
    if (!sidingFit(ctx.net, siding.id, lengthM).ok) continue;
    for (const origin of ENTRIES) {
      for (const destination of EXITS) {
        for (const onwardClass of onwardClasses(stock)) {
          const plans = planEcsCycles(ctx, { origin, siding: siding.id, destination, lengthM, stopMarginM: ECS_STOP_MARGIN_M, onwardClass, model: stock.model });
          const best = plans.length > 0 ? Math.min(...plans.map((p) => p.arrival.bays.length + p.departure.bays.length)) : 0;
          // simplest cycles, and ones with one more reversal, so the reversal place varies from shift to shift
          for (const plan of plans.filter((p) => p.arrival.bays.length + p.departure.bays.length <= best + 1).slice(0, 4)) out.push({ stock, origin, siding: siding.id, onwardClass, destination, stablingS: 0, plan });
        }
      }
    }
  }
  return out;
}

/** Builds a fully timed ECS cycle: one service whose times run from entry to stabled, siding departure and exit. */
export function buildEcsService(ctx: SignallingContext, c: EcsChoice, headcode: string, onwardHeadcode: string, entryS: number): ServiceSchedule | null {
  const prof = ecsProfile(ctx, { stock: c.stock, origin: c.origin, siding: c.siding, onward: { headcode: onwardHeadcode, trainClass: c.onwardClass, destination: c.destination }, plan: c.plan });
  if (!prof) return null;
  const arrivalS = entryS + ceil10(prof.entryToStabledS);
  const departureS = arrivalS + c.stablingS + ceil10(prof.stabledToLeavingS);
  const exitS = arrivalS + c.stablingS + ceil10(prof.stabledToExitS);
  const entryLine: LineName = lineOf(ctx, [...ctx.net.boundaries.values()].find((b) => b.id === c.origin)?.at.section);
  const exitLine: LineName = lineOf(ctx, [...ctx.net.boundaries.values()].find((b) => b.id === c.destination)?.at.section);
  const ecs: EcsSchedule = {
    siding: c.siding,
    stablingS: c.stablingS,
    onward: { headcode: onwardHeadcode, trainClass: c.onwardClass, destination: c.destination, exitLine },
    approach: c.plan.arrival.movements,
    departure: c.plan.departure.movements,
    approachBays: c.plan.arrival.bays,
    departureBays: c.plan.departure.bays,
  };
  const sections = [...new Set([...c.plan.arrival.movements, ...c.plan.departure.movements].flatMap((m) => ctx.route(m)?.sections ?? []))];
  return {
    id: headcode,
    headcode,
    trainClass: 5,
    model: c.stock.model,
    formation: c.stock.formation,
    origin: c.origin,
    destination: c.destination,
    entryLine,
    exitLine,
    planId: c.plan.id,
    routeLabel: `${c.plan.arrival.label}  ⟶  ${ctx.net.sidings.get(c.siding)?.name ?? c.siding}  ⟶  ${c.plan.departure.label}`,
    sections,
    manual: [...c.plan.arrival.movements, ...c.plan.departure.movements],
    stops: false,
    platform: null,
    minDwellS: 0,
    scheduledDwellS: 0,
    entryS,
    arrivalS,
    departureS,
    passS: null,
    exitS,
    ecs,
  };
}

export function makeHeadcode(rng: Rng, trainClass: number, used: Set<string>): string {
  for (let i = 0; i < 500; i++) {
    const h = `${trainClass}${rng.pick([...(LETTERS[trainClass] ?? 'A')])}${rng.int(10, 99)}`;
    if (!used.has(h)) {
      used.add(h);
      return h;
    }
  }
  throw new Error('headcode pool exhausted');
}

// ---------------------------------------------------------------------------
// Coordinated planning (Phase 10)
// ---------------------------------------------------------------------------

/** Who holds what, when: the generator's index of the services placed so far. A candidate is checked in a few lookups, not against every service. */
export class Occupancy {
  private readonly byResource = new Map<string, (readonly [number, number])[]>();
  private readonly entries = new Map<string, number[]>();

  add(s: ServiceSchedule, windows: readonly Window[]): void {
    for (const w of windows) {
      let list = this.byResource.get(w.resource);
      if (!list) this.byResource.set(w.resource, (list = []));
      list.push([w.from, w.to]);
    }
    let e = this.entries.get(s.origin);
    if (!e) this.entries.set(s.origin, (e = []));
    e.push(s.entryS);
  }

  /** Would this service, entering at `shiftS` seconds later than its zero-based windows say, be too close to anything placed? */
  free(rel: readonly Window[], origin: string, entryS: number, sepS: number, headwayS: number): boolean {
    for (const t of this.entries.get(origin) ?? []) if (Math.abs(t - entryS) < headwayS) return false;
    for (const w of rel) {
      const list = this.byResource.get(w.resource);
      if (!list) continue;
      const from = w.from + entryS;
      const to = w.to + entryS;
      for (const [a, b] of list) if (from - sepS < b && a - sepS < to) return false;
    }
    return true;
  }
}

/** A service built for entry time 0, with its zero-based windows: cheap to shift to any entry time (a multiple of 10 s keeps every rounded figure exact). */
interface Template {
  readonly svc: ServiceSchedule;
  readonly windows: readonly Window[];
}

const shifted = (svc: ServiceSchedule, t: number): ServiceSchedule => ({
  ...svc,
  entryS: svc.entryS + t,
  arrivalS: svc.arrivalS === null ? null : svc.arrivalS + t,
  departureS: svc.departureS === null ? null : svc.departureS + t,
  passS: svc.passS === null ? null : svc.passS + t,
  exitS: svc.exitS + t,
});

const inAreaTogether = (a: ServiceSchedule, b: ServiceSchedule): boolean => Math.min(a.exitS, b.exitS) > Math.max(a.entryS, b.entryS);

/**
 * How useful a candidate is to the traffic pattern: each service already in the area at the same time counts, and counts
 * for more when the pair interacts in one of the ways a signaller has to manage (opposing directions, an express past a
 * stopping train, the branch beside the main line, ECS beside passengers). Weighted by the difficulty.
 */
function overlapScore(cand: ServiceSchedule, placed: readonly ServiceSchedule[], interactionWeight: number): { overlaps: number; score: number } {
  let overlaps = 0;
  let score = 0;
  for (const p of placed) {
    if (!inAreaTogether(cand, p)) continue;
    overlaps++;
    score += 1 + interactionWeight * interactionKinds(cand, p).length;
  }
  return { overlaps, score };
}

/** Quick, schedule-free judgement of how a journey would pair with what is placed, to steer WHICH journey is chosen (the time is chosen afterwards). */
function journeyAppeal(j: Journey, placed: readonly ServiceSchedule[], weight: number): number {
  let w = 1;
  const dir = (o: string): 'UP' | 'DOWN' | 'BRANCH' => (o === 'W-IN' ? 'UP' : o === 'N-IN' ? 'DOWN' : 'BRANCH');
  for (const p of placed) {
    const mine = dir(j.origin);
    if ((mine === 'UP' && p.entryLine === 'DOWN') || (mine === 'DOWN' && p.entryLine === 'UP')) w += 0.25 * weight;
    if ((mine === 'BRANCH') !== (p.entryLine === 'BRANCH')) w += 0.1 * weight;
    if (p.origin === j.origin && p.destination === j.destination && p.platform === j.platform) w *= 0.6; // variety: not the same journey again
    if (j.platform !== null && p.platform === j.platform) w *= 0.85;
  }
  return w;
}

const roundMix = (rng: Rng, n: number, share: number): number => Math.round(n * share + (rng.next() - 0.5));

/** The class of each of `n` slots: Class 1, 2 and 5 in the difficulty's proportions, every class present. */
function classMix(rng: Rng, n: number, p: DifficultyProfile): TrainClassId[] {
  const c5 = Math.max(1, roundMix(rng, n, p.classShare.c5));
  const c1 = Math.max(1, Math.min(n - c5 - 1, roundMix(rng, n, p.classShare.c1)));
  const c2 = n - c1 - c5;
  return rng.shuffle([...Array(c1).fill(1), ...Array(c2).fill(2), ...Array(c5).fill(5)] as TrainClassId[]);
}

export interface PlanResult {
  readonly services: ServiceSchedule[];
  readonly requested: number;
  readonly reductionReasons: string[];
  readonly revisions: string[];
}

function attempt(ctx: SignallingContext, rng: Rng, stockRng: Rng, p: DifficultyProfile): PlanResult | null {
  const n = rng.int(p.countRange[0], p.countRange[1]);
  const classes = classMix(rng, n, p);
  const revisions: string[] = [];
  const reductionReasons: string[] = [];

  // 1. every service gets its rolling stock first; the stock decides what journeys it may be given
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
  const wantStop = (c: number, stock: StockRef): boolean => (c === 2 ? rng.next() < p.stopBias : c === 5 ? rng.next() < 0.35 : isFlexibleClass1(stock.model) ? rng.next() < 0.5 : false);

  // 2. some Class 5 slots become ECS siding cycles: a natural few, never a way of adding traffic
  const ecsPick: (EcsChoice | null)[] = classes.map(() => null);
  const class5 = classes.map((c, i) => (c === 5 ? i : -1)).filter((i) => i >= 0);
  const expected = n * p.ecsShare;
  const wantEcs = rng.next() < 0.3 ? 0 : Math.min(class5.length, p.ecsMax, Math.max(1, Math.floor(expected + rng.next())), Math.max(0, n - 3));
  const sidingUse = new Map<string, number>();
  for (const i of class5.slice(0, wantEcs)) {
    const all = ecsOptions(ctx, stocks[i] as StockRef);
    const fresh = all.filter((o) => (sidingUse.get(o.siding) ?? 0) === Math.min(...[...ctx.net.sidings.keys()].map((s) => sidingUse.get(s) ?? 0)));
    const pool = fresh.length > 0 && rng.next() < 0.75 ? fresh : all;
    if (pool.length === 0) continue; // this rolling stock fits no siding: the slot stays an ordinary Class 5 service
    const o = rng.pick(pool);
    ecsPick[i] = { ...o, stablingS: rng.pick(STABLING_CHOICES) };
    sidingUse.set(o.siding, (sidingUse.get(o.siding) ?? 0) + 1);
  }
  const isEcs = (i: number): boolean => ecsPick[i] !== null;

  // 3. coverage: one branch service (a Class 2 where possible), then one UP and one DOWN entry among the rest
  const firstTwo = classes.findIndex((c) => c === 2);
  const need = new Map<number, (j: Journey) => boolean>();
  if (firstTwo >= 0) need.set(firstTwo, (j) => j.origin === 'M-IO' || j.destination === 'M-IO');
  const order = rng.shuffle(classes.map((_, i) => i).filter((i) => i !== firstTwo && !isEcs(i)));
  const wants = ['W-IN', 'N-IN'];
  order.forEach((i, k) => {
    const w = wants[k];
    if (w) need.set(i, (j) => j.origin === w);
  });
  const stopFor = classes.map((c, i) => wantStop(c, stocks[i] as StockRef));
  const pool = (i: number): Journey[] => {
    const f = need.get(i);
    const all = optionsFor(i);
    const base = f ? all.filter(f) : all;
    const use = base.length > 0 ? base : all;
    const stopPool = use.filter((j) => (j.platform !== null) === stopFor[i]);
    return stopPool.length > 0 ? stopPool : use;
  };

  // 4. placement: coverage services first, then ECS, then the rest in a random order
  const sequence = [...[...(firstTwo >= 0 ? [firstTwo] : []), ...order.slice(0, 2)], ...classes.map((_, i) => i).filter((i) => isEcs(i)), ...order.slice(2)];
  const used = new Set<string>();
  const occ = new Occupancy();
  const placed: ServiceSchedule[] = [];
  const spanTarget = n * p.spanPerServiceS;
  const sep = SEPARATION_S + p.marginS;
  const headway = ENTRY_HEADWAY_S + p.marginS;
  const T_MIN = round10(rng.int(30, 120));

  for (const i of sequence) {
    const c = classes[i] as TrainClassId;
    const ecsChoice = ecsPick[i] ?? null;
    const headcode = makeHeadcode(rng, ecsChoice ? 5 : c, used);
    const onwardHeadcode = ecsChoice ? makeHeadcode(rng, ecsChoice.onwardClass, used) : '';
    const dwell = (j: Journey | null): number => (j && j.platform ? rng.pick(DWELLS[j.trainClass] ?? [60]) : 0);

    // the journeys to try, best-suited first: an ECS slot has one; others are drawn by how well they pair with what is placed
    const tries: (Journey | null)[] = [];
    if (ecsChoice) tries.push(null);
    else {
      const candidates = [...pool(i)];
      for (let k = 0; k < 3 && candidates.length > 0; k++) {
        const weights = candidates.map((j) => ({ j, weight: journeyAppeal(j, placed, p.interactionWeight) }));
        const w = pickWeighted(rng, weights);
        tries.push(w.j);
        candidates.splice(candidates.indexOf(w.j), 1);
      }
      if (tries.length === 0) {
        reductionReasons.push(`${headcode}: no journey is available for Class ${c} with ${(stocks[i] as StockRef).model}.`);
        continue;
      }
    }

    let chosen: ServiceSchedule | null = null;
    let why = '';
    for (const [ti, j] of tries.entries()) {
      const tpl = templateFor(ctx, j, ecsChoice, headcode, onwardHeadcode, dwell(j));
      if (!tpl) {
        why = `${headcode}: the journey cannot be measured`;
        continue;
      }
      const from = placed.length === 0 ? T_MIN : 30;
      // the shift's length is about n × spanPerServiceS: look there first, then later if nothing fits (never into a conflict)
      let hi = Math.max(spanTarget, ...placed.map((s) => s.exitS)) + 120;
      for (let pass = 0; pass < 4 && chosen === null; pass++, hi += 900) {
        const feasible: { t: number; svc: ServiceSchedule; overlaps: number; score: number }[] = [];
        for (let t = pass === 0 ? from : hi - 900; t <= hi; t += 10) {
          if (!occ.free(tpl.windows, tpl.svc.origin, t, sep, headway)) continue;
          const svc = shifted(tpl.svc, t);
          const o = overlapScore(svc, placed, p.interactionWeight);
          feasible.push({ t, svc, ...o });
        }
        if (feasible.length === 0) continue;
        const overlapping = feasible.filter((f) => f.overlaps > 0);
        let pick: (typeof feasible)[number];
        if (placed.length > 0 && overlapping.length > 0 && rng.next() < p.overlapBias) {
          // deliberate overlap: among the most useful candidates (the earliest of equals: closely sequenced)
          const best = [...overlapping].sort((x, y) => y.score - x.score || x.t - y.t).slice(0, 4);
          pick = rng.pick(best);
        } else {
          // independent: the least overlap there is, anywhere in the shift's span
          const least = Math.min(...feasible.map((f) => f.overlaps));
          const quiet = feasible.filter((f) => f.overlaps === least && f.t <= Math.max(spanTarget, 300));
          pick = rng.pick(quiet.length > 0 ? quiet : feasible.filter((f) => f.overlaps === least));
        }
        chosen = pick.svc;
        if (pass > 0) revisions.push(`${headcode}: no room within the planned span; placed ${Math.round(pick.t / 60)} min in, later than planned.`);
      }
      if (chosen) {
        if (ti > 0) revisions.push(`${headcode}: ${tries[0] ? describe(tries[0]) : 'first choice'} had no conflict-free time; re-chosen as ${j ? describe(j) : 'ECS cycle'}.`);
        const svc = chosen;
        occ.add(svc, tpl.windows.map((w) => ({ resource: w.resource, from: w.from + svc.entryS, to: w.to + svc.entryS })));
        break;
      }
      why = `${headcode}: no conflict-free time ${j ? `for ${describe(j)}` : 'for the ECS cycle'}`;
    }
    if (!chosen) {
      reductionReasons.push(`${why}; the service was dropped.`);
      continue;
    }
    placed.push(chosen);
  }
  if (placed.length < MIN_SERVICES) return null;
  if (placed.length < n) revisions.push(`${n - placed.length} of ${n} requested services could not be placed.`);
  const sorted = placed.sort((a, b) => a.entryS - b.entryS);
  const issue = ecsPlacementIssue(sorted);
  if (issue) {
    revisions.push(`attempt rejected: ${issue}`);
    return null;
  }
  return { services: sorted, requested: n, reductionReasons, revisions };
}

const describe = (j: Journey): string => `${j.origin} → ${j.destination}${j.platform ? ` via ${j.platform}` : ' non-stop'}`;

function templateFor(ctx: SignallingContext, j: Journey | null, ecs: EcsChoice | null, headcode: string, onwardHeadcode: string, dwellS: number): Template | null {
  const svc = ecs ? buildEcsService(ctx, ecs, headcode, onwardHeadcode, 0) : j ? buildService(ctx, j, headcode, 0, dwellS) : null;
  if (!svc) return null;
  const windows = windowsOf(ctx, svc);
  return windows ? { svc, windows } : null;
}

/**
 * An ECS siding cycle must not come last or second to last (it would leave the signaller idle), and its outgoing
 * departure must not be later than the last train's departure. Returns a description of the breach, or null.
 */
export function ecsPlacementIssue(services: readonly ServiceSchedule[]): string | null {
  const byEntry = [...services].sort((a, b) => a.entryS - b.entryS);
  const lastDeparture = Math.max(...services.filter((s) => !s.ecs).map((s) => s.exitS), 0);
  for (const [i, s] of byEntry.entries()) {
    if (!s.ecs) continue;
    if (i >= byEntry.length - 2) return `${s.headcode} (ECS) is among the last two services`;
    const dep = s.departureS ?? s.exitS;
    if (dep > lastDeparture) return `${s.headcode} departs its siding at ${dep} s, after the last train's departure (${lastDeparture} s)`;
  }
  return null;
}

export interface GenerateOptions {
  /** The shift's difficulty (default beginner). */
  readonly difficulty?: DifficultyId;
  /** Attempts before the fallback is used (default MAX_ATTEMPTS). 0 forces the fallback. */
  readonly maxAttempts?: number;
}

export const finish = (ctx: SignallingContext, services: ServiceSchedule[], seed: number, usedFallback: boolean, attempts: number, rejected: string[], p: DifficultyProfile, plan?: Pick<PlanResult, 'requested' | 'reductionReasons' | 'revisions'>): Timetable => {
  const requested = plan?.requested ?? services.length;
  const reductionReasons = [...(plan?.reductionReasons ?? [])];
  if (usedFallback) reductionReasons.push(`The fixed fallback timetable was used (${services.length} services) because generation did not produce a valid shift.`);
  else if (services.length < p.countRange[0] && reductionReasons.length === 0) reductionReasons.push(`Only ${services.length} services could be placed without a conflict.`);
  return {
    seed,
    difficulty: p.id,
    startClockS: SHIFT_START_CLOCK_S,
    services,
    endS: Math.max(...services.map((s) => s.exitS)),
    usedFallback,
    attempts,
    rejected,
    report: { difficulty: p.id, targetRange: p.countRange, requested, generated: services.length, reductionReasons, revisions: [...(plan?.revisions ?? []), ...rejected], stats: analyseTraffic(ctx, services) },
  };
};

/** A playable, validated timetable for this seed and difficulty. Never throws for a normal network. */
export function generateTimetable(ctx: SignallingContext, seed: number, options: GenerateOptions = {}): Timetable {
  if ((ctx.net.def.terminals?.length ?? 0) > 0) return generateTerminusTimetable(ctx, seed, options);
  const profile = difficultyProfile(options.difficulty ?? DEFAULT_DIFFICULTY);
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const rng = new Rng(seed * 2654435761 + 12345);
  const stockRng = new Rng(seed * 40503 + 977);
  const rejected: string[] = [];
  const validation = { countRange: [MIN_SERVICES, profile.countRange[1]] as const };
  for (let a = 1; a <= maxAttempts; a++) {
    const plan = attempt(ctx, rng, stockRng, profile);
    if (!plan) {
      rejected.push(`attempt ${a}: no valid set of journeys`);
      continue;
    }
    const issues = validateTimetable(ctx, { services: plan.services }, validation);
    if (issues.length > 0) {
      rejected.push(`attempt ${a}: ${issues[0]}`);
      continue;
    }
    // Aim for the difficulty's amount of overlap; if many attempts cannot manage it, accept less (never invent an unsafe overlap).
    const target = profile.minMaxConcurrent;
    const want = a <= maxAttempts / 2 ? target : Math.min(target, a <= (maxAttempts * 3) / 4 ? 2 : 1);
    const present = concurrencyStats(plan.services).maxPresent;
    if (present < want) {
      rejected.push(`attempt ${a}: only ${present} train(s) ever present together (wanted ${want})`);
      continue;
    }
    return finish(ctx, plan.services, seed, false, a, rejected, profile, plan);
  }
  return fallbackTimetable(ctx, seed, maxAttempts, rejected, profile.id);
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
export function fallbackTimetable(ctx: SignallingContext, seed = 0, attempts = 0, rejected: string[] = [], difficulty: DifficultyId = DEFAULT_DIFFICULTY): Timetable {
  for (let spread = 1; spread <= 6; spread += 0.5) {
    const services: ServiceSchedule[] = [];
    for (const d of FALLBACK) {
      const plans = sensiblePlans(ctx, planServices(ctx, { trainClass: d.trainClass, origin: d.origin, destination: d.destination, platform: d.platform, lengthM: stockPerformance(d.stock).lengthM, model: d.stock.model }), d.platform);
      const plan = plans[0];
      if (!plan) continue;
      const svc = buildService(ctx, { trainClass: d.trainClass, stock: d.stock, origin: d.origin, destination: d.destination, platform: d.platform, plan }, d.headcode, round10(d.entryS * spread), d.dwellS);
      if (svc) services.push(svc);
    }
    if (validateTimetable(ctx, { services }, { countRange: [MIN_SERVICES, 25] }).length === 0) return finish(ctx, services, seed, true, attempts, rejected, difficultyProfile(difficulty));
  }
  throw new Error('The fallback timetable is invalid: the network has changed.');
}
