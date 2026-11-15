/**
 * What a timetable asks of the signaller (Phase 10). Measured from the scheduled resource windows, so it uses the same
 * figures as the validator. Used by the generator (to prefer useful overlap) and for the testing information; it never
 * decides what is SAFE (validate.ts does).
 */

import type { SignallingContext } from '../signalling';
import { concurrencyStats } from './concurrency';
import type { InteractionKind, ServiceSchedule, TrafficStats } from './types';
import { windowsOf, type Window } from './validate';

/** Uses of something shared closer together than this count as a close sequence. */
export const CLOSE_SEQUENCE_S = 120;

export const INTERACTION_KINDS: readonly InteractionKind[] = ['opposing', 'express-local', 'branch-main', 'ecs-passenger'];

const usesBranch = (s: ServiceSchedule): boolean => s.entryLine === 'BRANCH' || s.exitLine === 'BRANCH';
const through = (s: ServiceSchedule): boolean => !s.ecs && !s.stops && s.passS !== null;

/** The kinds of interaction two services have, judged from their schedules alone (cheap: used while placing). */
export function interactionKinds(a: ServiceSchedule, b: ServiceSchedule): InteractionKind[] {
  const out: InteractionKind[] = [];
  const lines = new Set([a.entryLine, b.entryLine]);
  if (lines.has('UP') && lines.has('DOWN')) out.push('opposing');
  const local = (x: ServiceSchedule, y: ServiceSchedule): boolean =>
    through(x) && y.stops && y.arrivalS !== null && y.departureS !== null && (x.passS as number) >= y.arrivalS - 90 && (x.passS as number) <= y.departureS + 60;
  if (local(a, b) || local(b, a)) out.push('express-local');
  if (usesBranch(a) !== usesBranch(b)) out.push('branch-main');
  if (Boolean(a.ecs) !== Boolean(b.ecs)) out.push('ecs-passenger');
  return out;
}

const inArea = (a: ServiceSchedule, b: ServiceSchedule): boolean => Math.min(a.exitS, b.exitS) > Math.max(a.entryS, b.entryS);

const isJunction = (resource: string): boolean => resource.startsWith('point ') || resource.startsWith('crossing ');

export function analyseTraffic(ctx: SignallingContext, services: readonly ServiceSchedule[]): TrafficStats {
  const win = services.map((s) => windowsOf(ctx, s) ?? []);
  const byKind: Record<InteractionKind, number> = { opposing: 0, 'express-local': 0, 'branch-main': 0, 'ecs-passenger': 0 };
  let overlapping = 0;
  let independent = 0;
  let junction = 0;
  let close = 0;
  for (let i = 0; i < services.length; i++) {
    for (let j = i + 1; j < services.length; j++) {
      const a = services[i] as ServiceSchedule;
      const b = services[j] as ServiceSchedule;
      if (!inArea(a, b)) continue;
      overlapping++;
      for (const k of interactionKinds(a, b)) byKind[k]++;
      const wb = new Map<string, Window[]>();
      for (const w of win[j] as Window[]) (wb.get(w.resource) ?? wb.set(w.resource, []).get(w.resource))?.push(w);
      let shared = false;
      let sharedJunction = false;
      let gap = Infinity;
      for (const x of win[i] as Window[]) {
        for (const y of wb.get(x.resource) ?? []) {
          shared = true;
          if (isJunction(x.resource)) sharedJunction = true;
          gap = Math.min(gap, Math.max(0, x.from - y.to, y.from - x.to));
        }
      }
      if (!shared) independent++;
      else {
        if (sharedJunction) junction++;
        if (gap < CLOSE_SEQUENCE_S) close++;
      }
    }
  }
  return { services: services.length, maxConcurrent: concurrencyStats(services).maxPresent, overlappingPairs: overlapping, independentSimultaneous: independent, junctionInteractions: junction, closeSequences: close, byKind };
}
