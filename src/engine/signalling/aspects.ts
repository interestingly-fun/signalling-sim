/**
 * Signal aspect calculation. This is the ONLY place aspects are decided.
 * Nothing in the UI or in route setting can set an aspect; an aspect is always
 * a function of the state.
 *
 * Which movement does a signal protect?
 *   manual    : the route established from it (none = Red).
 *   automatic : its single derived movement, always.
 *
 * Does that movement allow the signal to clear?
 *   manual    : the route is "proven": it is recorded, it still holds every
 *               section and point lock, every point is in the required position,
 *               and no section is occupied.
 *   automatic : every section is clear and not reserved by any route, no
 *               crossing section is reserved, every point is in the required
 *               position and not locked, and no established route opposes it.
 *
 * Which colour? From the next signal, using the simplified four-aspect rule:
 *   next Red              -> Single Yellow
 *   next Single Yellow    -> Double Yellow
 *   next Double Yellow/Green -> Green
 * The next signal is the one the movement ends at. A movement that ends at an
 * exit boundary sees the neighbouring area as clear (treated as Green).
 */

import { opposingSection, type SignallingContext } from './context';
import { isSectionOccupied } from './state';
import type { Aspect, SignallingState } from './types';
import type { DerivedRoute } from '../topology/types';

/** Aspect shown when the signal ahead shows `next`. */
export function aspectBehind(next: Aspect): Aspect {
  switch (next) {
    case 'red':
      return 'yellow';
    case 'yellow':
      return 'double-yellow';
    case 'double-yellow':
    case 'green':
      return 'green';
  }
}

/** Has the interlocking proven this established route: locks held, points in position, track clear? */
export function isRouteProven(state: SignallingState, route: DerivedRoute): boolean {
  if (state.routes[route.from] !== route.id) return false;
  for (const s of route.sections) {
    if (state.sectionLocks[s] !== route.id) return false;
    if (isSectionOccupied(state, s)) return false;
  }
  for (const req of route.points) {
    if (state.pointLocks[req.point] !== route.id) return false;
    if (state.network.pointPositions[req.point] !== req.position) return false;
  }
  return true;
}

/** Is the movement an automatic signal protects clear of occupancy, reservations and opposing routes? */
export function isAutomaticMovementClear(ctx: SignallingContext, state: SignallingState, route: DerivedRoute): boolean {
  for (const s of route.sections) {
    if (isSectionOccupied(state, s)) return false;
    if (state.sectionLocks[s] !== undefined) return false;
    for (const crossing of ctx.crossings(s)) if (state.sectionLocks[crossing] !== undefined) return false;
  }
  for (const req of route.points) {
    if (state.network.pointPositions[req.point] !== req.position) return false;
    if (state.pointLocks[req.point] !== undefined) return false;
  }
  const info = ctx.info(route.id);
  for (const otherId of Object.values(state.routes)) {
    if (opposingSection(info, ctx.info(otherId)) !== null) return false;
  }
  return true;
}

/** The movement a signal currently protects and may clear for, or null (Red). */
function clearableMovement(ctx: SignallingContext, state: SignallingState, signalId: string): DerivedRoute | null {
  const signal = ctx.net.signals.get(signalId);
  if (!signal) return null;

  if (signal.type === 'manual') {
    const routeId = state.routes[signalId];
    const route = routeId === undefined ? undefined : ctx.route(routeId);
    return route && isRouteProven(state, route) ? route : null;
  }

  const movements = ctx.from(signalId);
  const only = movements.length === 1 ? movements[0] : undefined;
  return only && isAutomaticMovementClear(ctx, state, only) ? only : null;
}

/**
 * EFFECTIVE aspect of every signal in the network: what is actually displayed.
 * An automatic signal the operator has forced to Danger shows Red whatever its
 * movement looks like, and the signals behind it see a Red signal ahead.
 */
export function computeAspects(ctx: SignallingContext, state: SignallingState): Readonly<Record<string, Aspect>> {
  return calculateAspects(ctx, state, true);
}

/**
 * The aspects the signals WOULD show with no operator overrides. Overrides are
 * a separate record, so this is the automatic calculation that resumes when an
 * override is removed. Display only: nothing that decides safety uses it.
 */
export function computeUnderlyingAspects(ctx: SignallingContext, state: SignallingState): Readonly<Record<string, Aspect>> {
  return calculateAspects(ctx, state, false);
}

function calculateAspects(ctx: SignallingContext, state: SignallingState, honourOverrides: boolean): Readonly<Record<string, Aspect>> {
  const memo = new Map<string, Aspect>();

  const aspectOf = (signalId: string, visiting: ReadonlySet<string>): Aspect => {
    const known = memo.get(signalId);
    if (known) return known;
    if (visiting.has(signalId)) return 'red'; // cannot happen in a sane network; fail safe
    const forced = honourOverrides && state.signalOverrides[signalId] === 'FORCED_DANGER';
    const movement = forced ? null : clearableMovement(ctx, state, signalId);
    let aspect: Aspect = 'red';
    if (movement) {
      const next: Aspect = movement.toKind === 'boundary' ? 'green' : aspectOf(movement.to, new Set(visiting).add(signalId));
      aspect = aspectBehind(next);
    }
    memo.set(signalId, aspect);
    return aspect;
  };

  const out: Record<string, Aspect> = {};
  for (const id of ctx.net.signals.keys()) out[id] = aspectOf(id, new Set());
  return out;
}
