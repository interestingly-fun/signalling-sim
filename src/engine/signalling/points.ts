/**
 * Point positioning.
 *
 * A point may move only if it is not locked by a route and the section that
 * physically contains it (its toe section, see types.ts) is clear.
 */

import type { PointPosition } from '../topology/types';
import type { SignallingContext } from './context';
import { isSectionOccupied } from './state';
import type { PointMoveResult, SignallingState } from './types';

/** Why a point cannot move right now, or null if it can. */
export type PointBlock =
  | { readonly kind: 'locked'; readonly point: string; readonly owner: string }
  | { readonly kind: 'occupied'; readonly point: string; readonly section: string };

export function pointBlock(ctx: SignallingContext, state: SignallingState, pointId: string): PointBlock | null {
  const point = ctx.net.points.get(pointId);
  if (!point) throw new Error(`Unknown point "${pointId}"`);
  const owner = state.pointLocks[pointId];
  if (owner !== undefined) return { kind: 'locked', point: pointId, owner };
  if (isSectionOccupied(state, point.toe.section)) return { kind: 'occupied', point: pointId, section: point.toe.section };
  return null;
}

export function pointPosition(state: SignallingState, pointId: string): PointPosition {
  return state.network.pointPositions[pointId] ?? 'normal';
}

/** Moves one point. Used by the (test) point control; route setting moves points through establishRoute. */
export function movePoint(ctx: SignallingContext, state: SignallingState, pointId: string, position: PointPosition): PointMoveResult {
  if (!ctx.net.points.has(pointId)) {
    return { ok: false, state, rejection: { code: 'NO_SUCH_MOVEMENT', subject: pointId, message: `Unknown point ${pointId}.` } };
  }
  if (pointPosition(state, pointId) === position) {
    return { ok: true, state, message: `Point ${pointId} is already ${position}.` };
  }
  const block = pointBlock(ctx, state, pointId);
  if (block?.kind === 'locked') {
    return {
      ok: false,
      state,
      rejection: { code: 'POINT_LOCKED', subject: pointId, owner: block.owner, message: `Point ${pointId} cannot move: it is locked by route ${block.owner}.` },
    };
  }
  if (block?.kind === 'occupied') {
    return {
      ok: false,
      state,
      rejection: { code: 'POINT_OCCUPIED', subject: pointId, message: `Point ${pointId} cannot move: section ${block.section} is occupied.` },
    };
  }
  const next: SignallingState = { ...state, network: { ...state.network, pointPositions: { ...state.network.pointPositions, [pointId]: position } } };
  return { ok: true, state: next, message: `Point ${pointId} moved to ${position}.` };
}
