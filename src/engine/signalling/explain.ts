/**
 * Plain-English explanation of why a signal shows its aspect.
 *
 * This is READ-ONLY feedback for the signaller. It never decides anything: the
 * aspect itself always comes from computeAspects. The checks below mirror the
 * ones in aspects.ts, and the test suite proves that a Red signal always gets a
 * concrete reason (never the fallback), so the two cannot drift apart unnoticed.
 */

import { opposingSection, type SignallingContext } from './context';
import { computeAspects, isRouteProven } from './aspects';
import { isSectionOccupied } from './state';
import type { Aspect, SignallingState } from './types';
import type { DerivedRoute } from '../topology/types';

export const ASPECT_NAMES: Readonly<Record<Aspect, string>> = {
  red: 'Red – Danger',
  yellow: 'Single Yellow – Caution',
  'double-yellow': 'Double Yellow – Preliminary caution',
  green: 'Green – Clear',
};

export interface AspectExplanation {
  readonly aspect: Aspect;
  /** One sentence: what is holding the signal at Red, or what it is showing a caution for. */
  readonly reason: string;
}

/** The first reason an ESTABLISHED manual route is not proven, or null. */
function unprovenReason(state: SignallingState, route: DerivedRoute): string | null {
  for (const s of route.sections) {
    if (isSectionOccupied(state, s)) return `Section ${s} is occupied.`;
  }
  for (const s of route.sections) {
    if (state.sectionLocks[s] !== route.id) return `Section ${s} is not reserved for route ${route.id}.`;
  }
  for (const req of route.points) {
    if (state.pointLocks[req.point] !== route.id) return `Point ${req.point} is not locked for route ${route.id}.`;
    if (state.network.pointPositions[req.point] !== req.position) {
      return `Point ${req.point} is not in the ${req.position} position required by route ${route.id}.`;
    }
  }
  return null;
}

/** The first reason an AUTOMATIC signal's movement is not clear, or null. */
function blockedAutomaticReason(ctx: SignallingContext, state: SignallingState, route: DerivedRoute): string | null {
  for (const s of route.sections) {
    if (isSectionOccupied(state, s)) return `Section ${s} is occupied.`;
    const owner = state.sectionLocks[s];
    if (owner !== undefined) return `Section ${s} is reserved by route ${owner}.`;
    for (const crossing of ctx.crossings(s)) {
      const crossOwner = state.sectionLocks[crossing];
      if (crossOwner !== undefined) return `Section ${crossing}, which crosses ${s}, is reserved by route ${crossOwner}.`;
    }
  }
  for (const req of route.points) {
    if (state.network.pointPositions[req.point] !== req.position) return `Point ${req.point} is not in the ${req.position} position.`;
    const owner = state.pointLocks[req.point];
    if (owner !== undefined) return `Point ${req.point} is locked by route ${owner}.`;
  }
  const info = ctx.info(route.id);
  for (const otherId of Object.values(state.routes)) {
    const clash = opposingSection(info, ctx.info(otherId));
    if (clash !== null) return `Route ${otherId} runs against this movement over section ${clash}.`;
  }
  return null;
}

export function explainAspect(
  ctx: SignallingContext,
  state: SignallingState,
  signalId: string,
  aspects: Readonly<Record<string, Aspect>> = computeAspects(ctx, state),
): AspectExplanation {
  const signal = ctx.net.signals.get(signalId);
  const aspect = aspects[signalId] ?? 'red';
  if (!signal) return { aspect, reason: `${signalId} is not a signal.` };
  if (state.signalOverrides[signalId] === 'FORCED_DANGER') {
    return { aspect, reason: 'Forced to Danger by the signaller (manual override). Its automatic calculation resumes when it is returned to automatic.' };
  }

  let movement: DerivedRoute | undefined;
  if (signal.type === 'manual') {
    const routeId = state.routes[signalId];
    movement = routeId === undefined ? undefined : ctx.route(routeId);
    if (!movement) return { aspect, reason: 'No route is set from this signal.' };
    const why = isRouteProven(state, movement) ? null : unprovenReason(state, movement);
    if (why) return { aspect, reason: why };
  } else {
    movement = ctx.from(signalId)[0];
    if (!movement) return { aspect, reason: 'This signal protects no movement.' };
    const why = blockedAutomaticReason(ctx, state, movement);
    if (why) return { aspect, reason: why };
  }

  if (aspect === 'red') return { aspect, reason: 'Held at Red by the interlocking.' }; // fallback: the tests prove it is never reached
  if (movement.toKind === 'boundary') return { aspect, reason: 'The line ahead to the boundary is clear.' };
  const next = aspects[movement.to] ?? 'red';
  return { aspect, reason: `Route clear. Next signal ${movement.to} shows ${ASPECT_NAMES[next]}.` };
}
