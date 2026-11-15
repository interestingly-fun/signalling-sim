/**
 * Corridors and platform access (Northbridge). Hard infrastructure rules, enforced by the interlocking.
 *
 * A corridor is an independent route between the area and one neighbouring place (AJ, BR). Every section of a corridor carries its id;
 * shared track (a terminus throat or platform) carries none. A train belongs to the corridor of the boundary it entered by and keeps
 * it for the whole shift, including after it has changed ends: it may only be given routes in that corridor, and only platforms
 * whose `access` lists it.
 */

import type { Network } from '../topology/network';
import type { DerivedRoute } from '../topology/types';
import type { Train } from './types';

/** The corridor a boundary belongs to, or undefined (single-corridor network). */
export const boundaryCorridor = (net: Network, boundaryId: string): string | undefined => {
  const b = net.boundaries.get(boundaryId);
  return b ? net.sections.get(b.at.section)?.corridor : undefined;
};

export const trainCorridor = (net: Network, train: Pick<Train, 'spec'>): string | undefined => boundaryCorridor(net, train.spec.origin);

/** The corridors whose track a route uses (shared track is none). A valid route uses at most one. */
export function routeCorridors(net: Network, route: Pick<DerivedRoute, 'sections'>): string[] {
  const out = new Set<string>();
  for (const s of route.sections) {
    const c = net.sections.get(s)?.corridor;
    if (c) out.add(c);
  }
  return [...out];
}

/** May a train of this corridor use this platform? */
export function platformAllows(net: Network, platformId: string, corridor: string | undefined): boolean {
  const access = net.platforms.get(platformId)?.access;
  return !access || corridor === undefined || access.includes(corridor);
}
