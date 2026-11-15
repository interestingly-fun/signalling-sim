/**
 * Derives the table of possible signal-to-signal movements from the topology.
 *
 * Nothing here is hand-written per route: every route is found by walking the
 * graph from a signal until the next signal (or an exit boundary) is reached,
 * branching at every facing point. Consequently a movement can only appear in
 * this table if the sections, links and points genuinely connect, and only in
 * directions the sections allow.
 *
 * This is a READ-ONLY query used for design review and tested for consistency.
 * Phase 2 (route setting) builds on it: locking, conflicts, signal clearing.
 */

import { otherEnd, type Network } from './network';
import { stepsFrom } from './traversal';
import type { DerivedRoute, PointRequirement, SectionEnd } from './types';

interface PartialRoute {
  sections: string[];
  points: PointRequirement[];
}

function describe(net: Network, p: PartialRoute): string[] {
  const features: string[] = [];
  const add = (f: string) => {
    if (!features.includes(f)) features.push(f);
  };
  for (const sid of p.sections) {
    const s = net.sections.get(sid);
    if (!s) continue;
    if (s.platform) add(net.platforms.get(s.platform)?.name ?? s.platform);
    if (s.line === 'BRANCH') add('Branch');
    for (const j of net.junctions.values()) {
      if (s.line === 'CROSSOVER' && j.sections?.includes(sid)) add(j.name);
    }
    if (s.crosses && s.crosses.length > 0) add('Diamond crossing');
  }
  return features;
}

export function deriveRoutes(net: Network): DerivedRoute[] {
  const routes: DerivedRoute[] = [];
  const idCount = new Map<string, number>();

  const emit = (from: string, to: string, toKind: 'signal' | 'boundary', p: PartialRoute, reverseRunning: boolean, shuntAccess = false) => {
    const base = `${from}>${to}`;
    const n = (idCount.get(base) ?? 0) + 1;
    idCount.set(base, n);
    const features = describe(net, p);
    if (reverseRunning) features.push('Wrong-line running');
    routes.push({
      id: n === 1 ? base : `${base}#${n}`,
      from,
      to,
      toKind,
      sections: p.sections,
      points: p.points,
      features,
      description: features.length > 0 ? `via ${features.join(', ')}` : 'straight',
      ...(shuntAccess ? { shuntAccess: true as const } : {}),
    });
  };

  // A main-line shunting signal only STARTS movements into the sidings (it must take its point in the reverse position); movements of
  // other signals run straight through it, and it never ends a route.
  const diverges = (signal: { mainline?: boolean }, p: PartialRoute): boolean => !signal.mainline || p.points.some((r) => r.position === 'reverse');

  for (const signal of net.signals.values()) {
    const walk = (leaving: SectionEnd, partial: PartialRoute, visited: Set<string>, reverse: boolean): void => {
      for (const step of stepsFrom(net, leaving)) {
        if (step.kind === 'exit' || step.kind === 'buffer') {
          if (!diverges(signal, partial)) continue;
          emit(signal.id, step.boundary, 'boundary', partial, reverse);
          continue;
        }
        const sectionId = step.enter.section;
        if (visited.has(sectionId)) continue;

        let points = partial.points;
        if (step.requires) {
          const existing = points.find((r) => r.point === step.requires?.point);
          if (existing && existing.position !== step.requires.position) continue; // contradictory settings
          if (!existing) points = [...points, step.requires];
        }

        const section = net.sections.get(sectionId);
        // "Wrong-line running": eastbound on a DOWN-main section or westbound on an UP-main section.
        const wrong =
          reverse || (section?.line === 'DOWN' && step.enter.end === 'A') || (section?.line === 'UP' && step.enter.end === 'B');

        // Siding track is entered only by a movement that starts at a shunting signal: an ordinary signal reaches the sidings by
        // a route to its ASSOCIATED shunting signal (below), never straight through it.
        if (section?.line === 'SIDING' && signal.type !== 'shunting') continue;

        const next: PartialRoute = { sections: [...partial.sections, sectionId], points };
        const nextLeaving: SectionEnd = { section: sectionId, end: otherEnd(step.enter.end) };
        const nextSignal = net.signalLeaving(nextLeaving);
        if (nextSignal && !nextSignal.mainline) {
          if (diverges(signal, next)) emit(signal.id, nextSignal.id, 'signal', next, wrong);
        } else {
          // A shunting access route: an ordinary signal to the main-line shunting signal it is associated with. Ordinary movements
          // still run straight on through that signal (the walk continues below).
          if (nextSignal?.mainline && signal.type !== 'shunting' && nextSignal.associatedMain?.includes(signal.id)) emit(signal.id, nextSignal.id, 'signal', next, wrong, true);
          walk(nextLeaving, next, new Set(visited).add(sectionId), wrong);
        }
      }
    };

    walk(signal.at, { sections: [], points: [] }, new Set([signal.at.section]), false);
  }

  return routes;
}

export function routesFrom(routes: readonly DerivedRoute[], signalId: string): DerivedRoute[] {
  return routes.filter((r) => r.from === signalId);
}
