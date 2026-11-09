/**
 * Read-only lookups over the Phase 1 network and its derived route table.
 *
 * This is an INDEX of the existing derived routes, not a second route graph:
 * every entry comes from deriveRoutes(). On top of that it records, for each
 * route, the direction in which it runs through each section; that is what lets
 * the interlocking recognise opposing movements on bi-directional track.
 */

import { otherEnd, type Network } from '../topology/network';
import { deriveRoutes } from '../topology/routeTable';
import { stepsFrom } from '../topology/traversal';
import type { DerivedRoute } from '../topology/types';

/** Direction of travel through a section: from end A to end B, or B to A. */
export type Direction = 'AB' | 'BA';

export interface RouteInfo {
  readonly route: DerivedRoute;
  /** The section the entrance signal stands in, and the direction a train leaves it. */
  readonly entrance: { readonly section: string; readonly dir: Direction };
  /** Direction of travel through each section of the route. */
  readonly dirs: ReadonlyMap<string, Direction>;
}

export interface SignallingContext {
  readonly net: Network;
  readonly routes: readonly DerivedRoute[];
  route(id: string): DerivedRoute | undefined;
  info(id: string): RouteInfo;
  /** Every derived route that starts at the given signal. */
  from(signalId: string): readonly DerivedRoute[];
  /** Every derived route between the two signals (or from a signal to a boundary). */
  between(from: string, to: string): readonly DerivedRoute[];
  /** Sections that physically cross the given one (diamond crossings). */
  crossings(sectionId: string): readonly string[];
}

function buildInfo(net: Network, route: DerivedRoute): RouteInfo {
  const signal = net.signals.get(route.from);
  if (!signal) throw new Error(`Route ${route.id} starts at unknown signal ${route.from}`);

  const dirs = new Map<string, Direction>();
  let leaving = signal.at;
  for (const sectionId of route.sections) {
    const step = stepsFrom(net, leaving).find((s) => s.kind === 'enter' && s.enter.section === sectionId);
    if (!step || step.kind !== 'enter') throw new Error(`Route ${route.id}: cannot enter ${sectionId} from ${leaving.section}.${leaving.end}`);
    dirs.set(sectionId, step.enter.end === 'A' ? 'AB' : 'BA');
    leaving = { section: sectionId, end: otherEnd(step.enter.end) };
  }
  return { route, entrance: { section: signal.at.section, dir: signal.at.end === 'B' ? 'AB' : 'BA' }, dirs };
}

export function createSignallingContext(net: Network, routes: readonly DerivedRoute[] = deriveRoutes(net)): SignallingContext {
  const byId = new Map(routes.map((r) => [r.id, r]));
  const infos = new Map(routes.map((r) => [r.id, buildInfo(net, r)]));

  const crossingMap = new Map<string, string[]>();
  for (const s of net.sections.values()) {
    if (s.crosses && s.crosses.length > 0) crossingMap.set(s.id, [...s.crosses]);
  }

  return {
    net,
    routes,
    route: (id) => byId.get(id),
    info(id) {
      const info = infos.get(id);
      if (!info) throw new Error(`Unknown route "${id}"`);
      return info;
    },
    from: (signalId) => routes.filter((r) => r.from === signalId),
    between: (from, to) => routes.filter((r) => r.from === from && r.to === to),
    crossings: (sectionId) => crossingMap.get(sectionId) ?? [],
  };
}

/**
 * Do two routes run against each other on a section that only one of them has
 * RESERVED? Route sections are protected by locks; this covers the section a
 * route's entrance signal stands in, which is not part of the route itself.
 * Returns that section's ID, or null.
 *
 * Following moves (same direction) are allowed: a train may be signalled into
 * a section behind another train.
 */
export function opposingSection(a: RouteInfo, b: RouteInfo): string | null {
  const bOnA = b.dirs.get(a.entrance.section);
  if (bOnA !== undefined && bOnA !== a.entrance.dir) return a.entrance.section;
  const aOnB = a.dirs.get(b.entrance.section);
  if (aOnB !== undefined && aOnB !== b.entrance.dir) return b.entrance.section;
  if (a.entrance.section === b.entrance.section && a.entrance.dir !== b.entrance.dir) return a.entrance.section;
  return null;
}
