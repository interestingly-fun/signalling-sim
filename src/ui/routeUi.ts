/**
 * Entrance-to-exit route selection, as plain functions.
 *
 * This is the interaction state machine behind the diagram, kept out of React so
 * it can be tested without a browser:
 *
 *   1. click a manual signal          -> it becomes the ENTRANCE
 *   2. click a signal it can reach    -> the interlocking is asked to set that route AT ONCE
 *
 * A refused route leaves the entrance selected (and the refused movement shown
 * as blocked) so another exit can be tried. Escape or a second click on the
 * entrance cancels the selection.
 *
 * Nothing here decides whether a route is safe. Every verdict comes from the
 * signalling engine (validateRoute / requestRoute / cancelRoute).
 */

import {
  cancelRoute,
  requestRoute,
  validateCancel,
  validateRoute,
  type DerivedRoute,
  type SignallingContext,
  type SignallingState,
} from '../engine';

export interface RouteUi {
  /** Manual signal chosen as the entrance, or null. */
  readonly entrance: string | null;
  /** The proposed movement from that entrance, or null while no exit is chosen. */
  readonly routeId: string | null;
}

export const emptyRouteUi: RouteUi = { entrance: null, routeId: null };

export type MessageKind = 'ok' | 'error' | 'info';

export interface Message {
  readonly kind: MessageKind;
  readonly text: string;
}

export interface UiUpdate {
  readonly ui: RouteUi;
  readonly message?: Message;
  /** Present only when the click changed the signalling state (a route was established). */
  readonly state?: SignallingState;
}

export interface OperationUpdate {
  readonly state: SignallingState;
  readonly ui: RouteUi;
  readonly message: Message;
}

const pointsText = (route: DerivedRoute): string =>
  route.points.length === 0 ? 'no points' : route.points.map((p) => `${p.point} ${p.position === 'normal' ? 'N' : 'R'}`).join(', ');

/** Feedback for a movement the signaller has just proposed. */
export function describeProposal(ctx: SignallingContext, state: SignallingState, route: DerivedRoute): Message {
  const rejection = validateRoute(ctx, state, route.id);
  if (rejection) return { kind: 'error', text: rejection.message };
  return {
    kind: 'info',
    text: `Proposed route ${route.from} → ${route.to} over ${route.sections.join(' › ')} (points: ${pointsText(route)}). Click exit signal ${route.to} to set it.`,
  };
}

/** Signals the given entrance can be routed to. */
export const destinationsFor = (ctx: SignallingContext, entrance: string | null): readonly string[] =>
  entrance === null ? [] : [...new Set(ctx.from(entrance).map((r) => r.to))];

/** The player clicked a signal on the diagram. */
export function clickSignal(ctx: SignallingContext, state: SignallingState, ui: RouteUi, signalId: string): UiUpdate {
  const signal = ctx.net.signals.get(signalId);
  if (!signal) return { ui };

  if (ui.entrance === null) {
    if (signal.type === 'automatic') {
      return { ui, message: { kind: 'info', text: `Signal ${signalId} is automatic. Its aspect is set by the signalling system; routes cannot be set from it.` } };
    }
    const existing = state.routes[signalId];
    if (existing !== undefined) {
      return {
        ui: { entrance: signalId, routeId: existing },
        message: { kind: 'info', text: `Signal ${signalId} has route ${existing} established. Use “Cancel route” to release it.` },
      };
    }
    return { ui: { entrance: signalId, routeId: null }, message: { kind: 'info', text: `Entrance ${signalId} selected. Click the exit signal you want to route to.` } };
  }

  // an entrance is already chosen
  if (signalId === ui.entrance) return { ui: emptyRouteUi, message: { kind: 'info', text: `Selection cleared.` } };

  const first = ctx.between(ui.entrance, signalId)[0];
  if (!first) {
    // A different manual signal that is not a destination starts a new selection instead.
    if (signal.type === 'manual') return clickSignal(ctx, state, emptyRouteUi, signalId);
    return { ui, message: { kind: 'error', text: `Invalid movement: no valid connection between ${ui.entrance} and ${signalId}.` } };
  }
  return establishMovement(ctx, state, ui, first.id);
}

/**
 * Ask the interlocking to establish a movement from the selected entrance.
 * Success clears the selection. Refusal keeps the entrance and shows the
 * refused movement as blocked, with the interlocking's own reason.
 */
export function establishMovement(ctx: SignallingContext, state: SignallingState, ui: RouteUi, routeId: string): UiUpdate {
  const route = ctx.route(routeId);
  if (!route) return { ui, message: { kind: 'error', text: `Invalid movement: route ${routeId} does not exist.` } };
  const result = requestRoute(ctx, state, route.from, route.to, route.id);
  if (!result.ok) return { ui: { entrance: route.from, routeId: route.id }, message: { kind: 'error', text: result.rejection.message } };
  return { ui: emptyRouteUi, state: result.state, message: { kind: 'ok', text: result.message } };
}

/** The player picked a specific movement (from the movements table or the inspector). */
export function previewMovement(ctx: SignallingContext, state: SignallingState, routeId: string): UiUpdate {
  const route = ctx.route(routeId);
  if (!route) return { ui: emptyRouteUi };
  const established = state.routes[route.from] === route.id;
  if (established) {
    return { ui: { entrance: route.from, routeId }, message: { kind: 'info', text: `Route ${route.from} → ${route.to} is established.` } };
  }
  return { ui: { entrance: route.from, routeId }, message: describeProposal(ctx, state, route) };
}

/** "Set route": ask the interlocking to establish the proposed movement. */
export function submitRoute(ctx: SignallingContext, state: SignallingState, ui: RouteUi): OperationUpdate {
  if (ui.entrance === null || ui.routeId === null) {
    return { state, ui, message: { kind: 'error', text: 'Choose an entrance signal and an exit signal first.' } };
  }
  const route = ctx.route(ui.routeId);
  if (!route) return { state, ui, message: { kind: 'error', text: `Invalid movement: route ${ui.routeId} does not exist.` } };

  const result = requestRoute(ctx, state, route.from, route.to, route.id);
  if (!result.ok) return { state, ui, message: { kind: 'error', text: result.rejection.message } };
  return { state: result.state, ui: emptyRouteUi, message: { kind: 'ok', text: result.message } };
}

/** "Cancel route": release an established route if that is safe. */
export function submitCancel(ctx: SignallingContext, state: SignallingState, ui: RouteUi, routeId: string): OperationUpdate {
  const result = cancelRoute(ctx, state, routeId);
  if (!result.ok) return { state, ui, message: { kind: 'error', text: result.rejection.message } };
  const nextUi = ui.routeId === routeId || ui.entrance === result.route.from ? emptyRouteUi : ui;
  return { state: result.state, ui: nextUi, message: { kind: 'ok', text: result.message } };
}

/** Why an established route cannot be cancelled right now, or null if it can. */
export const cancelBlock = (ctx: SignallingContext, state: SignallingState, routeId: string): string | null =>
  validateCancel(ctx, state, routeId)?.message ?? null;
