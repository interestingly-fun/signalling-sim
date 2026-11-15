/**
 * Lock management: the ONLY place where established routes and their section
 * and point locks are added or removed. Both operations touch all three
 * records together, so they cannot drift apart.
 */

import type { DerivedRoute } from '../topology/types';
import type { SignallingContext } from './context';
import type { SignallingState } from './types';

/** Records a route and locks its sections and points. Caller has already validated. */
export function lockRoute(state: SignallingState, route: DerivedRoute): SignallingState {
  const sectionLocks: Record<string, string> = { ...state.sectionLocks };
  for (const s of route.sections) sectionLocks[s] = route.id;
  const pointLocks: Record<string, string> = { ...state.pointLocks };
  for (const p of route.points) pointLocks[p.point] = route.id;
  return { ...state, routes: { ...state.routes, [route.from]: route.id }, sectionLocks, pointLocks };
}

/** Removes a route and ONLY the locks that belong to it (whole-route release). */
export function unlockRoute(state: SignallingState, route: DerivedRoute): SignallingState {
  const keep = (locks: Readonly<Record<string, string>>): Record<string, string> =>
    Object.fromEntries(Object.entries(locks).filter(([, owner]) => owner !== route.id));
  const routes = Object.fromEntries(Object.entries(state.routes).filter(([, id]) => id !== route.id));
  const residual = Object.fromEntries(Object.entries(state.residual).filter(([id]) => id !== route.id)) as Record<string, true>;
  return { ...state, routes, residual, sectionLocks: keep(state.sectionLocks), pointLocks: keep(state.pointLocks) };
}

/**
 * A train has passed the route's entrance signal. The signal stops owning the
 * route (it goes back to Red behind the train) but every lock is kept, now as a
 * RESIDUAL route, to be freed section by section by `releaseCleared`.
 */
export function detachRoute(state: SignallingState, route: DerivedRoute): SignallingState {
  if (state.routes[route.from] !== route.id) return state;
  const routes = Object.fromEntries(Object.entries(state.routes).filter(([, id]) => id !== route.id));
  return { ...state, routes, residual: { ...state.residual, [route.id]: true } };
}

/**
 * SECTIONAL RELEASE. Frees the locks of a residual route that a train has
 * physically cleared: each section in `cleared` (the rear has passed its end),
 * and each point once every section of the route that touches it is free.
 * Locks never owned by this route are never touched. When nothing of the route
 * is left locked, it stops being residual. Returns the state itself if nothing changed.
 */
export function releaseCleared(ctx: SignallingContext, state: SignallingState, route: DerivedRoute, cleared: ReadonlySet<string>): SignallingState {
  if (!state.residual[route.id]) return state;
  const sectionLocks: Record<string, string> = { ...state.sectionLocks };
  let changed = false;
  for (const s of route.sections) {
    if (cleared.has(s) && sectionLocks[s] === route.id) {
      delete sectionLocks[s];
      changed = true;
    }
  }
  const pointLocks: Record<string, string> = { ...state.pointLocks };
  for (const req of route.points) {
    if (pointLocks[req.point] !== route.id) continue;
    const def = ctx.net.points.get(req.point);
    const touching = def ? [def.toe.section, def.normal.section, def.reverse.section].filter((s) => route.sections.includes(s)) : [];
    if (touching.every((s) => sectionLocks[s] !== route.id)) {
      delete pointLocks[req.point];
      changed = true;
    }
  }
  if (!changed) return state;
  const stillHeld = Object.values(sectionLocks).includes(route.id) || Object.values(pointLocks).includes(route.id);
  const residual = stillHeld ? state.residual : (Object.fromEntries(Object.entries(state.residual).filter(([id]) => id !== route.id)) as Record<string, true>);
  return { ...state, sectionLocks, pointLocks, residual };
}

/** Is this route still held, wholly or in part, by a train running over it? */
export const isResidual = (state: SignallingState, routeId: string): boolean => state.residual[routeId] === true;

/** Established route IDs, in no particular order. */
export const establishedRouteIds = (state: SignallingState): string[] => Object.values(state.routes);

/**
 * Consistency check used by tests: the lock records must be exactly the union
 * of what the established routes require. Returns problems (empty = consistent).
 */
export function checkLockInvariants(ctx: SignallingContext, state: SignallingState): string[] {
  const issues: string[] = [];
  const expectedSections = new Map<string, string>();
  const expectedPoints = new Map<string, string>();

  for (const [signalId, routeId] of Object.entries(state.routes)) {
    const route = ctx.route(routeId);
    if (!route) {
      issues.push(`established route ${routeId} does not exist`);
      continue;
    }
    if (route.from !== signalId) issues.push(`route ${routeId} is recorded against signal ${signalId} but starts at ${route.from}`);
    for (const s of route.sections) {
      const prev = expectedSections.get(s);
      if (prev !== undefined) issues.push(`section ${s} is required by both ${prev} and ${routeId}`);
      expectedSections.set(s, routeId);
    }
    for (const p of route.points) {
      const prev = expectedPoints.get(p.point);
      if (prev !== undefined) issues.push(`point ${p.point} is required by both ${prev} and ${routeId}`);
      expectedPoints.set(p.point, routeId);
    }
  }

  // Residual routes (entrance passed): their locks may be a SUBSET of the route's, never more.
  const residualIds = new Set(Object.keys(state.residual));
  for (const routeId of residualIds) {
    const route = ctx.route(routeId);
    if (!route) {
      issues.push(`residual route ${routeId} does not exist`);
      continue;
    }
    if (Object.values(state.routes).includes(routeId)) issues.push(`route ${routeId} is both established and residual`);
    const owned = [...Object.values(state.sectionLocks), ...Object.values(state.pointLocks)].includes(routeId);
    if (!owned) issues.push(`residual route ${routeId} holds no locks`);
  }
  for (const [s, owner] of Object.entries(state.sectionLocks)) {
    if (residualIds.has(owner)) {
      if (!ctx.route(owner)?.sections.includes(s)) issues.push(`section lock ${s} -> ${owner} is not a section of that route`);
      continue;
    }
    if (expectedSections.get(s) !== owner) issues.push(`section lock ${s} -> ${owner} has no matching established route`);
  }
  for (const [s, owner] of expectedSections) {
    if (state.sectionLocks[s] !== owner) issues.push(`section ${s} should be locked by ${owner}`);
  }
  for (const [p, owner] of Object.entries(state.pointLocks)) {
    if (residualIds.has(owner)) {
      if (!ctx.route(owner)?.points.some((r) => r.point === p)) issues.push(`point lock ${p} -> ${owner} is not a point of that route`);
      continue;
    }
    if (expectedPoints.get(p) !== owner) issues.push(`point lock ${p} -> ${owner} has no matching established route`);
  }
  for (const [p, owner] of expectedPoints) {
    if (state.pointLocks[p] !== owner) issues.push(`point ${p} should be locked by ${owner}`);
  }
  return issues;
}
