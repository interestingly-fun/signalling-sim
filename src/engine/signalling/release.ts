/**
 * Route cancellation and release.
 *
 * Phase 2 uses WHOLE-ROUTE release: all of a route's locks go together. The
 * lock records are per section and per point (locks.ts), so sectional release,
 * once trains exist, only needs to call a finer-grained version of unlockRoute.
 *
 * SAFETY RULE. A route cannot be cancelled while any of its sections is
 * occupied: that would free the points and sections under a train. There is no
 * approach locking yet; it needs trains (Phase 3).
 */

import type { SignallingContext } from './context';
import { unlockRoute } from './locks';
import { routeLabel } from './routeSetting';
import { isSectionOccupied } from './state';
import type { CancelResult, Rejection, SignallingState } from './types';

/** Can this established route be cancelled now? Returns the reason it cannot, or null. */
export function validateCancel(ctx: SignallingContext, state: SignallingState, routeId: string): Rejection | null {
  const route = ctx.route(routeId);
  if (!route || state.routes[route.from] !== routeId) {
    return { code: 'NOT_ESTABLISHED', subject: routeId, message: `Route ${routeId} is not established.` };
  }
  for (const s of route.sections) {
    if (isSectionOccupied(state, s)) {
      return { code: 'CANCEL_OCCUPIED', subject: s, message: `Route ${routeLabel(route)} cannot be cancelled: section ${s} is occupied.` };
    }
  }
  return null;
}

/** Operator cancellation: refused if it would be unsafe. Releases only this route's locks. */
export function cancelRoute(ctx: SignallingContext, state: SignallingState, routeId: string): CancelResult {
  const rejection = validateCancel(ctx, state, routeId);
  if (rejection) return { ok: false, state, rejection };
  const route = ctx.route(routeId);
  if (!route) return { ok: false, state, rejection: { code: 'NOT_ESTABLISHED', message: `Route ${routeId} is not established.` } };
  return { ok: true, state: unlockRoute(state, route), route, message: `Route ${routeLabel(route)} cancelled. Signal ${route.from} returns to Red.` };
}

/** Cancels whichever route is established from the given entrance signal. */
export function cancelRouteFrom(ctx: SignallingContext, state: SignallingState, signalId: string): CancelResult {
  const routeId = state.routes[signalId];
  if (routeId === undefined) {
    return { ok: false, state, rejection: { code: 'NOT_ESTABLISHED', subject: signalId, message: `No route is established from signal ${signalId}.` } };
  }
  return cancelRoute(ctx, state, routeId);
}
