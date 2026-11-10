/**
 * Service planner (Phase 4): which ways can a train of a given class get from
 * its origin boundary to its destination boundary, optionally calling at a
 * platform?
 *
 * It walks the LOGICAL network (sections and the ways they connect through
 * points, links and the diamond), ignoring where points currently lie, and
 * keeps only paths the class may use. For each path it names the signal-to-
 * signal movements the signaller has to set. Planning NEVER sets a route or
 * moves a point: the interlocking is the only thing that does that.
 */

import { otherEnd } from '../topology/network';
import { stepsFrom } from '../topology/traversal';
import type { SignallingContext } from '../signalling/context';
import { signalAtEnd } from './lookahead';
import { classAllowsLine, permissionsFor } from './classes';
import { platformFit } from './platforms';
import type { PathStep } from './types';

export interface PlanQuery {
  readonly trainClass: number;
  readonly origin: string;
  readonly destination: string;
  /** Platform the train must stop at, or null/undefined to run through. */
  readonly platform?: string | null;
  readonly lengthM?: number;
  /** Rolling-stock model (Phase 7). Only matters for models that may work as Class 1 with regional permissions. */
  readonly model?: string;
}

export interface ServicePlan {
  readonly id: string;
  readonly path: readonly PathStep[];
  /** Short description such as "UP main › Platform 1 › UP main". */
  readonly label: string;
  /** Platforms the path runs over. */
  readonly platforms: readonly string[];
  /** Every movement along the path, in order (signal-to-signal). */
  readonly movements: readonly string[];
  /** The subset the signaller sets by hand (entrance signal is manual). */
  readonly manual: readonly string[];
  readonly usesBranch: boolean;
}

const MAX_PLANS = 40;
const MAX_DEPTH = 70;

const cache = new WeakMap<SignallingContext, Map<string, ServicePlan[]>>();

/** The legal plans for a query. Results depend only on the (fixed) network, so they are cached. */
export function planServices(ctx: SignallingContext, q: PlanQuery): ServicePlan[] {
  let byKey = cache.get(ctx);
  if (!byKey) cache.set(ctx, (byKey = new Map()));
  const key = `${q.trainClass}|${permissionsFor(q.trainClass, q.model).canStop}|${q.origin}|${q.destination}|${q.platform ?? ''}|${q.lengthM ?? ''}`;
  let plans = byKey.get(key);
  if (!plans) byKey.set(key, (plans = computePlans(ctx, q)));
  return plans;
}

function computePlans(ctx: SignallingContext, q: PlanQuery): ServicePlan[] {
  const net = ctx.net;
  const boundary = net.boundaries.get(q.origin);
  const dest = net.boundaries.get(q.destination);
  if (!boundary?.entry || !dest?.exit) return [];
  const perms = permissionsFor(q.trainClass, q.model);
  const platformSection = q.platform ? net.platforms.get(q.platform)?.section : undefined;
  if (q.platform) {
    if (!perms.canStop || !platformSection) return [];
    if (q.lengthM !== undefined && !platformFit(net, q.platform, q.lengthM).ok) return [];
  }
  const start = net.sections.get(boundary.at.section);
  if (!start || !classAllowsLine(q.trainClass, start.line, q.model)) return [];

  const plans: ServicePlan[] = [];
  const path: PathStep[] = [{ section: start.id, enterEnd: boundary.at.end }];
  const seen = new Set<string>([start.id]);

  const walk = (): void => {
    if (plans.length >= MAX_PLANS || path.length > MAX_DEPTH) return;
    const last = path[path.length - 1] as PathStep;
    for (const step of stepsFrom(net, { section: last.section, end: otherEnd(last.enterEnd) })) {
      if (step.kind === 'exit') {
        if (step.boundary === q.destination && (!platformSection || seen.has(platformSection))) plans.push(describe(ctx, [...path]));
        continue;
      }
      const sec = net.sections.get(step.enter.section);
      if (!sec || seen.has(sec.id) || !classAllowsLine(q.trainClass, sec.line, q.model)) continue;
      seen.add(sec.id);
      path.push({ section: sec.id, enterEnd: step.enter.end });
      walk();
      path.pop();
      seen.delete(sec.id);
    }
  };
  walk();
  return plans;
}

function describe(ctx: SignallingContext, path: PathStep[]): ServicePlan {
  const net = ctx.net;
  // Signals met, in order, as the train leaves each section.
  const marks: { signal: string; index: number }[] = [];
  path.forEach((p, i) => {
    const sig = signalAtEnd(net, { section: p.section, end: otherEnd(p.enterEnd) });
    if (sig) marks.push({ signal: sig.id, index: i });
  });
  const movements: string[] = [];
  const manual: string[] = [];
  const dest = path.length;
  marks.forEach((m, k) => {
    const next = marks[k + 1];
    const upTo = next ? next.index : dest - 1;
    const sections = path.slice(m.index + 1, upTo + 1).map((p) => p.section);
    const found = ctx.from(m.signal).find((r) => r.sections.length === sections.length && r.sections.every((s, i) => s === sections[i]) && (next ? r.to === next.signal : r.toKind === 'boundary'));
    if (found) {
      movements.push(found.id);
      if (net.signals.get(m.signal)?.type === 'manual') manual.push(found.id);
    }
  });

  const platforms = [...net.platforms.values()].filter((p) => path.some((s) => s.section === p.section));
  const runs: string[] = [];
  for (const p of path) {
    const sec = net.sections.get(p.section);
    if (!sec) continue;
    const plat = sec.platform ? net.platforms.get(sec.platform)?.name : undefined;
    const name = plat ?? (sec.line === 'UP' ? 'UP main' : sec.line === 'DOWN' ? 'DOWN main' : sec.line === 'BRANCH' ? 'Branch' : sec.line === 'CROSSOVER' ? 'Crossover' : sec.line === 'PLATFORM' ? 'Platform loop' : 'Link');
    if (runs[runs.length - 1] !== name) runs.push(name);
  }
  return {
    id: path.map((p) => p.section).join('-'),
    path,
    label: runs.join(' › '),
    platforms: platforms.map((p) => p.id),
    movements,
    manual,
    usesBranch: path.some((p) => net.sections.get(p.section)?.line === 'BRANCH'),
  };
}
