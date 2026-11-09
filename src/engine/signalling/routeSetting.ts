/**
 * Entrance-to-exit route setting.
 *
 *   validateRoute  : pure check, never changes anything (also drives the UI preview)
 *   establishRoute : validate, position the points, lock sections and points
 *   requestRoute   : entrance + exit signal IDs -> choose the movement -> establish
 *
 * ATOMICITY. All checks happen before anything is changed, and the new state is
 * built in one step. A refused request returns the state object it was given,
 * untouched: no point moved, no lock taken.
 */

import { opposingSection, type SignallingContext } from './context';
import { lockRoute } from './locks';
import { pointBlock, pointPosition } from './points';
import { isSectionOccupied } from './state';
import type { Rejection, RouteResult, SignallingState } from './types';
import type { DerivedRoute, PointPosition } from '../topology/types';

export const routeLabel = (route: DerivedRoute): string => `${route.from} → ${route.to}`;

/**
 * Can this movement be set right now? Returns the first reason it cannot, or null.
 * Checks, in order: movement exists, signal is manual, not already set, section
 * occupancy, section locks, diamond crossings, opposing movements, point locks,
 * and whether every point that has to move is free to do so.
 */
export function validateRoute(ctx: SignallingContext, state: SignallingState, routeId: string): Rejection | null {
  const route = ctx.route(routeId);
  if (!route) return { code: 'NO_SUCH_MOVEMENT', subject: routeId, message: `Invalid movement: route ${routeId} does not exist.` };

  const signal = ctx.net.signals.get(route.from);
  if (!signal || signal.type !== 'manual') {
    return { code: 'NOT_MANUAL', subject: route.from, message: `Signal ${route.from} is automatic: routes cannot be set from it.` };
  }

  const existing = state.routes[route.from];
  if (existing !== undefined) {
    return {
      code: 'ALREADY_SET',
      subject: route.from,
      owner: existing,
      message: `Route unavailable: signal ${route.from} already has route ${existing} established. Cancel it first.`,
    };
  }

  for (const s of route.sections) {
    if (isSectionOccupied(state, s)) {
      return { code: 'SECTION_OCCUPIED', subject: s, message: `Route unavailable: section ${s} is occupied.` };
    }
  }

  for (const s of route.sections) {
    const owner = state.sectionLocks[s];
    if (owner !== undefined) {
      return {
        code: 'SECTION_LOCKED',
        subject: s,
        owner,
        message: `Route unavailable: conflicting route ${owner} already established (section ${s} is reserved).`,
      };
    }
  }

  for (const s of route.sections) {
    for (const crossing of ctx.crossings(s)) {
      const owner = state.sectionLocks[crossing];
      if (owner !== undefined) {
        return {
          code: 'CROSSING_CONFLICT',
          subject: crossing,
          owner,
          message: `Route unavailable: conflicting route ${owner} already established (${crossing} crosses ${s} on the diamond).`,
        };
      }
    }
  }

  const info = ctx.info(route.id);
  for (const otherId of Object.values(state.routes)) {
    const clash = opposingSection(info, ctx.info(otherId));
    if (clash !== null) {
      return {
        code: 'OPPOSING_MOVEMENT',
        subject: clash,
        owner: otherId,
        message: `Route unavailable: conflicting route ${otherId} already established (opposing movement over section ${clash}).`,
      };
    }
  }

  for (const req of route.points) {
    const owner = state.pointLocks[req.point];
    if (owner !== undefined) {
      return {
        code: 'POINT_LOCKED',
        subject: req.point,
        owner,
        message: `Route unavailable: point ${req.point} is locked by route ${owner}.`,
      };
    }
  }

  for (const req of route.points) {
    if (pointPosition(state, req.point) === req.position) continue; // already correct, no movement needed
    const block = pointBlock(ctx, state, req.point);
    if (block?.kind === 'occupied') {
      return {
        code: 'POINT_OCCUPIED',
        subject: req.point,
        message: `Route unavailable: point ${req.point} cannot move while section ${block.section} is occupied.`,
      };
    }
  }

  return null;
}

/** Sets one specific movement. */
export function establishRoute(ctx: SignallingContext, state: SignallingState, routeId: string): RouteResult {
  const rejection = validateRoute(ctx, state, routeId);
  if (rejection) return { ok: false, state, rejection };

  const route = ctx.route(routeId);
  if (!route) return { ok: false, state, rejection: { code: 'NO_SUCH_MOVEMENT', message: `Invalid movement: route ${routeId} does not exist.` } };

  // Position the points: build the new positions in one step.
  const pointPositions: Record<string, PointPosition> = { ...state.network.pointPositions };
  const pointsMoved: string[] = [];
  for (const req of route.points) {
    if (pointPositions[req.point] !== req.position) {
      pointPositions[req.point] = req.position;
      pointsMoved.push(req.point);
    }
  }

  const positioned: SignallingState = { ...state, network: { ...state.network, pointPositions } };
  const next = lockRoute(positioned, route);

  const moved = pointsMoved.length > 0 ? ` Points moved: ${pointsMoved.map((p) => `${p} ${pointPositions[p] === 'reverse' ? 'R' : 'N'}`).join(', ')}.` : '';
  return { ok: true, state: next, route, pointsMoved, message: `Route ${routeLabel(route)} established.${moved}` };
}

/**
 * Entrance-to-exit request: find the movement between the two signals and set it.
 * `routeId` picks between alternatives if the network ever offers more than one
 * movement between the same two signals; otherwise the first settable one is used.
 */
export function requestRoute(ctx: SignallingContext, state: SignallingState, from: string, to: string, routeId?: string): RouteResult {
  if (!ctx.net.signals.has(from)) {
    return { ok: false, state, rejection: { code: 'NO_SUCH_MOVEMENT', subject: from, message: `Invalid movement: ${from} is not a signal.` } };
  }
  const candidates = ctx.between(from, to).filter((r) => routeId === undefined || r.id === routeId);
  if (candidates.length === 0) {
    return {
      ok: false,
      state,
      rejection: { code: 'NO_SUCH_MOVEMENT', subject: from, message: `Invalid movement: no valid connection between ${from} and ${to}.` },
    };
  }

  let firstFailure: RouteResult | null = null;
  for (const candidate of candidates) {
    const result = establishRoute(ctx, state, candidate.id);
    if (result.ok) return result;
    firstFailure ??= result;
  }
  return firstFailure ?? { ok: false, state, rejection: { code: 'NO_SUCH_MOVEMENT', message: `Invalid movement: no valid connection between ${from} and ${to}.` } };
}
