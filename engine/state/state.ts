/**
 * Mutable railway STATE, kept separate from the immutable topology.
 *
 * Phase 1 only needs two things per network: which point is in which position,
 * and which section is occupied. All updates return a NEW state object so that
 * the UI (and later the simulation loop) can rely on predictable updates.
 *
 * NOTE: the `review*` functions below bypass all interlocking on purpose. They
 * exist so the layout can be inspected in Phase 1 ("does flipping this point
 * change which sections connect?"). In Phase 2 point movement goes through
 * route setting and locking, and these will be removed or guarded.
 */

import type { Network } from '../topology/network';
import type { PointPosition } from '../topology/types';

export interface NetworkState {
  /** Position of every point. */
  readonly pointPositions: Readonly<Record<string, PointPosition>>;
  /** Occupying train ID per section, or null when the section is clear. */
  readonly sectionOccupancy: Readonly<Record<string, string | null>>;
}

export function createInitialState(net: Network): NetworkState {
  const pointPositions: Record<string, PointPosition> = {};
  for (const id of net.points.keys()) pointPositions[id] = 'normal';
  const sectionOccupancy: Record<string, string | null> = {};
  for (const id of net.sections.keys()) sectionOccupancy[id] = null;
  return { pointPositions, sectionOccupancy };
}

export function isOccupied(state: NetworkState, sectionId: string): boolean {
  return (state.sectionOccupancy[sectionId] ?? null) !== null;
}

/** REVIEW AID (Phase 1): moves a point with no interlocking checks. */
export function reviewSetPointPosition(state: NetworkState, pointId: string, position: PointPosition): NetworkState {
  if (!(pointId in state.pointPositions)) throw new Error(`Unknown point "${pointId}"`);
  return { ...state, pointPositions: { ...state.pointPositions, [pointId]: position } };
}

/** REVIEW AID (Phase 1): marks a section occupied/clear with no train behind it. */
export function reviewSetOccupied(state: NetworkState, sectionId: string, occupied: boolean): NetworkState {
  if (!(sectionId in state.sectionOccupancy)) throw new Error(`Unknown section "${sectionId}"`);
  return { ...state, sectionOccupancy: { ...state.sectionOccupancy, [sectionId]: occupied ? 'REVIEW' : null } };
}
