/**
 * Northbridge timetable generation (terminating services, two corridors).
 *
 * Every Northbridge service is a TERMINATING cycle: it enters from Ashcombe Junction (AJ) or Barchester (BR), optionally calls at a
 * Northbridge-West platform, terminates at a platform it is allowed (corridor access), dwells, changes ends under a new headcode,
 * optionally calls again westbound and leaves by its own corridor. Journeys are chosen from the planner (`planTerminalCycles`), timed by
 * the real engine (`terminalProfile`), and placed over an occupancy index exactly like the Ashcombe generator does, so a candidate
 * time with ANY conflict inside the margin is refused. If the railway cannot hold the target count a smaller valid timetable is made.
 *
 * Class suggestions are only suggestions: express (flexible Class 1) trains prefer the fast line on entry and BR trains of any class
 * may enter on either line. The signaller chooses fast or slow when routing the departure.
 */

import type { SignallingContext } from '../signalling';
import { getModel, isFlexibleClass1, modelsForClass, stockPerformance, type StockRef } from '../rollingstock';
import { boundaryCorridor, permissionsFor, planTerminalCycles, platformAllows, platformFit, type TerminalPlan } from '../trains';
import { concurrencyStats } from './concurrency';
import { DEFAULT_DIFFICULTY, difficultyProfile, type DifficultyId, type DifficultyProfile } from './difficulty';
import { finish, makeHeadcode, Occupancy, pickStock, SHIFT_START_CLOCK_S, MAX_ATTEMPTS, type GenerateOptions } from './generate';
import { Rng } from './rng';
import type { EcsSchedule, ServiceSchedule, Timetable } from './types';
import { ENTRY_HEADWAY_S, SEPARATION_S, terminalProfileOf, validateTimetable, windowsOf, type Window } from './validate';

const ceil10 = (n: number): number => Math.ceil(n / 10) * 10;
const MIN_TERMINUS_SERVICES = 3;
const STOP_MARGIN_M = 12;
const NBW_IN: Record<string, string> = { AJ: 'NBW1', BR: 'NBW3' };
const NBW_OUT: Record<string, string> = { AJ: 'NBW2', BR: 'NBW4' };
type Cls = 1 | 2 | 5;

export interface TerminusChoice {
  readonly stock: StockRef;
  readonly trainClass: Cls;
  readonly onwardClass: Cls;
  readonly origin: string;
  readonly platform: string;
  readonly destination: string;
  readonly dwellS: number;
  readonly inboundCall: boolean;
  readonly outboundCall: boolean;
  readonly plan: TerminalPlan;
}

/** Entry and exit boundaries of the network, by corridor. */
function boundaries(ctx: SignallingContext): { entries: Map<string, string[]>; exits: Map<string, string[]> } {
  const entries = new Map<string, string[]>();
  const exits = new Map<string, string[]>();
  for (const b of ctx.net.boundaries.values()) {
    if (b.buffer) continue;
    const c = boundaryCorridor(ctx.net, b.id) ?? '';
    if (b.entry) entries.set(c, [...(entries.get(c) ?? []), b.id]);
    if (b.exit) exits.set(c, [...(exits.get(c) ?? []), b.id]);
  }
  return { entries, exits };
}

/** Flexible Class 1 stock: the models that may work an express and still terminate. */
function expressStock(rng: Rng): StockRef | null {
  const models = modelsForClass(1).filter((m) => isFlexibleClass1(m.id));
  if (models.length === 0) return null;
  const m = rng.pick(models);
  return { model: m.id, formation: rng.pick(m.formations).id };
}

/** Builds a timetable entry for the choice, entering at time 0, with times from the measured lone-train profile. */
export function buildTerminusService(ctx: SignallingContext, c: TerminusChoice, headcode: string, onwardHeadcode: string, entryS = 0): ServiceSchedule | null {
  const corridor = boundaryCorridor(ctx.net, c.origin) ?? '';
  const inCall = c.inboundCall ? { platform: NBW_IN[corridor] as string, dwellS: 40 } : null;
  const outCall = c.outboundCall ? { platform: NBW_OUT[corridor] as string, dwellS: 40 } : null;
  const ecs: EcsSchedule = {
    siding: c.platform,
    stablingS: c.dwellS,
    onward: { headcode: onwardHeadcode, trainClass: c.onwardClass, destination: c.destination, exitLine: 'DOWN' },
    approach: c.plan.arrival.movements,
    departure: c.plan.departure.movements,
    approachBays: [],
    departureBays: [],
    terminal: { dwellS: c.dwellS, inboundCall: inCall, outboundCall: outCall },
  };
  const base: ServiceSchedule = {
    id: headcode,
    headcode,
    trainClass: c.trainClass,
    model: c.stock.model,
    formation: c.stock.formation,
    origin: c.origin,
    destination: c.destination,
    entryLine: 'UP',
    exitLine: 'DOWN',
    planId: c.plan.id,
    routeLabel: `${c.origin} → ${ctx.net.platforms.get(c.platform)?.name ?? c.platform} → ${c.destination}`,
    sections: [...new Set([...c.plan.arrival.movements, ...c.plan.departure.movements].flatMap((m) => ctx.route(m)?.sections ?? []))],
    manual: [...c.plan.arrival.movements, ...c.plan.departure.movements],
    stops: false,
    platform: null,
    minDwellS: c.dwellS,
    scheduledDwellS: c.dwellS,
    entryS,
    arrivalS: null,
    departureS: null,
    passS: null,
    exitS: 0,
    ecs,
  };
  const prof = terminalProfileOf(ctx, base);
  if (!prof) return null;
  return { ...base, arrivalS: entryS + ceil10(prof.entryToArrivalS), departureS: entryS + ceil10(prof.entryToDepartureS), exitS: entryS + ceil10(prof.entryToExitS) };
}

const shifted = (s: ServiceSchedule, t: number): ServiceSchedule => ({
  ...s,
  entryS: s.entryS + t,
  arrivalS: s.arrivalS === null ? null : s.arrivalS + t,
  departureS: s.departureS === null ? null : s.departureS + t,
  exitS: s.exitS + t,
});

/** Choices for a class: every origin, terminus platform and exit the planner can complete for this stock, weighted by suggestion only. */
export function terminusOptions(ctx: SignallingContext, rng: Rng, trainClass: Cls, stock: StockRef): TerminusChoice[] {
  const { entries, exits } = boundaries(ctx);
  const out: TerminusChoice[] = [];
  const lengthM = stockPerformance(stock).lengthM;
  const m = getModel(stock.model);
  const onwards: Cls[] = trainClass === 5 ? ([...(m?.classes.filter((c) => c === 1 || c === 2) ?? []), 5] as Cls[]) : [trainClass];
  for (const t of ctx.net.def.terminals ?? []) {
    if (!platformFit(ctx.net, t.platform, lengthM).ok) continue;
    for (const [corridor, origins] of entries) {
      if (!corridor || !platformAllows(ctx.net, t.platform, corridor)) continue;
      for (const origin of origins) {
        for (const destination of exits.get(corridor) ?? []) {
          for (const onwardClass of onwards) {
            const plan = planTerminalCycles(ctx, { origin, platform: t.platform, destination, lengthM, stopMarginM: STOP_MARGIN_M, trainClass, onwardClass, model: stock.model })[0];
            if (!plan) continue;
            const canCall = permissionsFor(trainClass, stock.model).canStop && trainClass === 2;
            out.push({
              stock, trainClass, onwardClass, origin, platform: t.platform, destination,
              dwellS: rng.pick(trainClass === 5 ? [120, 180, 240] : trainClass === 1 ? [90, 120] : [90, 120, 150]),
              inboundCall: canCall && rng.next() < 0.6,
              outboundCall: canCall && rng.next() < 0.4,
              plan,
            });
          }
        }
      }
    }
  }
  return out;
}

/** Entry/exit line preference: a suggestion only. Express trains lean towards the fast line, local ones towards the slow. */
const lineWeight = (c: TerminusChoice): number => {
  const slowIn = c.origin.endsWith('-S-IN');
  const slowOut = c.destination.endsWith('-S-OUT');
  const fastBias = c.trainClass === 1 ? 3 : 1;
  const w = (slow: boolean): number => (c.origin.startsWith('BR') ? (slow ? 1 : fastBias) : 1);
  return w(slowIn) * (slowOut ? 1 : 1);
};

interface TerminusPlanResult {
  readonly services: ServiceSchedule[];
  readonly requested: number;
  readonly reductionReasons: string[];
  readonly revisions: string[];
}

function attempt(ctx: SignallingContext, rng: Rng, stockRng: Rng, p: DifficultyProfile, scale: number): TerminusPlanResult | null {
  const requested = rng.int(p.countRange[0], p.countRange[1]);
  const n = Math.max(MIN_TERMINUS_SERVICES, Math.round(requested * scale));
  const used = new Set<string>();
  const c5 = Math.max(0, Math.min(Math.round(n * p.classShare.c5), p.ecsMax));
  const c1 = Math.max(1, Math.round(n * p.classShare.c1));
  const classes: Cls[] = rng.shuffle([...Array(Math.min(c1, n)).fill(1), ...Array(c5).fill(5), ...Array(Math.max(0, n - c1 - c5)).fill(2)] as Cls[]).slice(0, n);
  if (!classes.includes(2)) classes[0] = 2;
  const corridors = (ctx.net.def.corridors ?? []).map((c) => c.id);
  const templates: ServiceSchedule[] = [];
  const revisions: string[] = [];
  const corridorCount: Record<string, number> = {};
  for (let i = 0; i < classes.length; i++) {
    const cls = classes[i] as Cls;
    // alternate corridors with some randomness so both always carry traffic
    const want = corridors.length > 0 && (rng.next() < 0.7 ? corridors[i % corridors.length] : rng.pick(corridors));
    let stock: StockRef | null = cls === 1 ? expressStock(stockRng) : pickStock(stockRng, cls);
    if (!stock) {
      revisions.push('no flexible Class 1 stock: an express was made a Class 2 service');
      stock = pickStock(stockRng, 2);
    }
    const realCls: Cls = cls === 1 && !isFlexibleClass1(stock.model) ? 2 : cls;
    const opts = terminusOptions(ctx, rng, realCls, stock).filter((o) => !want || boundaryCorridor(ctx.net, o.origin) === want);
    if (opts.length === 0) {
      revisions.push(`${realCls === 1 ? 'express' : 'Class ' + realCls} ${stock.model}: no valid terminating journey for corridor ${want}`);
      continue;
    }
    // weighted pick with variety: not the same platform / origin again
    const weights = opts.map((o) => lineWeight(o) * (templates.some((t) => t.ecs?.siding === o.platform && t.origin === o.origin) ? 0.5 : 1));
    let r = rng.next() * weights.reduce((a, b) => a + b, 0);
    let pick = opts[opts.length - 1] as TerminusChoice;
    for (let k = 0; k < opts.length; k++) {
      r -= weights[k] as number;
      if (r < 0) {
        pick = opts[k] as TerminusChoice;
        break;
      }
    }
    const hc = makeHeadcode(rng, pick.trainClass, used);
    const onward = makeHeadcode(rng, pick.onwardClass, used);
    const svc = buildTerminusService(ctx, pick, hc, onward, 0);
    if (!svc) {
      revisions.push(`${hc}: its journey could not be measured, dropped`);
      continue;
    }
    templates.push(svc);
    const c = boundaryCorridor(ctx.net, pick.origin) ?? '';
    corridorCount[c] = (corridorCount[c] ?? 0) + 1;
  }
  if (templates.length < MIN_TERMINUS_SERVICES) return null;

  // Placement: one service at a time over the occupancy index (the same discipline as the Ashcombe generator).
  const occ = new Occupancy();
  const placed: ServiceSchedule[] = [];
  const reductionReasons: string[] = [];
  const sep = SEPARATION_S + p.marginS;
  const horizon = Math.max(600, templates.length * p.spanPerServiceS);
  let lastEntry = 0;
  for (const tpl of rng.shuffle(templates)) {
    const rel = windowsOf(ctx, tpl) as Window[] | null;
    if (!rel) continue;
    const free: number[] = [];
    for (let t = 0; t <= horizon + 600; t += 10) if (occ.free(rel, tpl.origin, t, sep, ENTRY_HEADWAY_S)) free.push(t);
    if (free.length === 0) {
      reductionReasons.push(`${tpl.headcode} could not be placed without a conflict.`);
      continue;
    }
    let t: number;
    if (placed.length > 0 && rng.next() < p.overlapBias) {
      // prefer a time when other services are in the area: the one with the most overlap, ties earliest
      let best = free[0] as number;
      let bestScore = -1;
      for (const f of free) {
        const cand = shifted(tpl, f);
        const overlaps = placed.filter((q) => Math.min(cand.exitS, q.exitS) > Math.max(cand.entryS, q.entryS));
        const cross = overlaps.filter((q) => boundaryCorridor(ctx.net, q.origin) !== boundaryCorridor(ctx.net, cand.origin)).length;
        const score = overlaps.length + p.interactionWeight * cross + rng.next() * 0.5;
        if (score > bestScore) {
          bestScore = score;
          best = f;
        }
      }
      t = best;
    } else {
      t = free.find((f) => f >= lastEntry) ?? (free[0] as number);
    }
    const svc = shifted(tpl, t);
    occ.add(svc, rel.map((w) => ({ resource: w.resource, from: w.from + t, to: w.to + t })));
    placed.push(svc);
    lastEntry = Math.max(lastEntry, t);
  }
  if (placed.length < MIN_TERMINUS_SERVICES) return null;
  const sorted = placed.sort((a, b) => a.entryS - b.entryS);
  if (sorted.length < requested) reductionReasons.push(`${sorted.length} of the requested ${requested} services could be placed safely.`);
  return { services: sorted, requested, reductionReasons: [...new Set(reductionReasons)].slice(0, 6), revisions };
}

/** A fixed, well-spread set covering both corridors and several platforms; validated like any other. */
export function fallbackTerminusTimetable(ctx: SignallingContext, seed: number, attempts: number, rejected: string[], difficulty: DifficultyId): Timetable {
  const defs: { hc: string; on: string; cls: Cls; onCls: Cls; stock: StockRef; origin: string; platform: string; dest: string; at: number; inCall: boolean; outCall: boolean }[] = [
    { hc: '2A10', on: '2A11', cls: 2, onCls: 2, stock: { model: '170', formation: '3-car' }, origin: 'AJ-IN', platform: 'T1', dest: 'AJ-OUT', at: 0, inCall: true, outCall: false },
    { hc: '2B20', on: '2B21', cls: 2, onCls: 2, stock: { model: '170', formation: '3-car' }, origin: 'BR-F-IN', platform: 'T5', dest: 'BR-S-OUT', at: 120, inCall: false, outCall: true },
    { hc: '2C30', on: '2C31', cls: 2, onCls: 2, stock: { model: '170', formation: '3-car' }, origin: 'AJ-IN', platform: 'T3', dest: 'AJ-OUT', at: 400, inCall: false, outCall: false },
    { hc: '2D40', on: '2D41', cls: 2, onCls: 2, stock: { model: '170', formation: '3-car' }, origin: 'BR-S-IN', platform: 'T6', dest: 'BR-F-OUT', at: 520, inCall: true, outCall: false },
  ];
  for (let spread = 1; spread <= 6; spread += 0.5) {
    const services: ServiceSchedule[] = [];
    for (const d of defs) {
      const plan = planTerminalCycles(ctx, { origin: d.origin, platform: d.platform, destination: d.dest, lengthM: stockPerformance(d.stock).lengthM, stopMarginM: STOP_MARGIN_M, trainClass: d.cls, onwardClass: d.onCls, model: d.stock.model })[0];
      if (!plan) continue;
      const svc = buildTerminusService(ctx, { stock: d.stock, trainClass: d.cls, onwardClass: d.onCls, origin: d.origin, platform: d.platform, destination: d.dest, dwellS: 90, inboundCall: d.inCall, outboundCall: d.outCall, plan }, d.hc, d.on, ceil10(d.at * spread));
      if (svc) services.push(svc);
    }
    if (validateTimetable(ctx, { services }, { countRange: [MIN_TERMINUS_SERVICES, 25] }).length === 0) return finish(ctx, services, seed, true, attempts, rejected, difficultyProfile(difficulty));
  }
  throw new Error('The Northbridge fallback timetable is invalid: the network has changed.');
}

export function generateTerminusTimetable(ctx: SignallingContext, seed: number, options: GenerateOptions = {}): Timetable {
  const profile = difficultyProfile(options.difficulty ?? DEFAULT_DIFFICULTY);
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const rng = new Rng(seed * 2654435761 + 54321);
  const stockRng = new Rng(seed * 40503 + 4177);
  const rejected: string[] = [];
  for (let a = 1; a <= maxAttempts; a++) {
    // later attempts ask for fewer services: a smaller valid timetable rather than an unsafe one
    const scale = a <= maxAttempts / 3 ? 1 : a <= (2 * maxAttempts) / 3 ? 0.8 : 0.6;
    const plan = attempt(ctx, rng, stockRng, profile, scale);
    if (!plan) {
      rejected.push(`attempt ${a}: no valid set of journeys`);
      continue;
    }
    const issues = validateTimetable(ctx, { services: plan.services }, { countRange: [MIN_TERMINUS_SERVICES, profile.countRange[1]] });
    if (issues.length > 0) {
      rejected.push(`attempt ${a}: ${issues[0]}`);
      continue;
    }
    const target = profile.minMaxConcurrent;
    const want = a <= maxAttempts / 2 ? target : Math.min(target, 2);
    const present = concurrencyStats(plan.services).maxPresent;
    if (present < want) {
      rejected.push(`attempt ${a}: only ${present} train(s) ever present together (wanted ${want})`);
      continue;
    }
    return finish(ctx, plan.services, seed, false, a, rejected, profile, plan);
  }
  return fallbackTerminusTimetable(ctx, seed, maxAttempts, rejected, profile.id);
}

/** The generator for this network: Northbridge-style terminus networks use their own, Ashcombe keeps its own. */
export const isTerminusNetwork = (ctx: SignallingContext): boolean => (ctx.net.def.terminals?.length ?? 0) > 0;
