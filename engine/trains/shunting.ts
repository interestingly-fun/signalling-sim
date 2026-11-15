/**
 * Shunting authority (Phase 9 correction). Pure functions; nothing here sets a route or an aspect.
 *
 * Two different authorities exist and they are never mixed:
 *
 *  - MAIN signal authority: an ordinary movement obeys the ordinary signal it meets, whatever any shunting signal shows.
 *    A shunting signal never clears a main signal, and a main signal at Danger is never passed.
 *
 *  - SHUNTING authority: a train making a SHUNTING MOVEMENT (an ECS train on its way into the sidings) obeys the main-line shunting
 *    signal at the throat (AJ1 / AJ4). The ordinary signal it is ASSOCIATED with (`SignalDef.associatedMain`) CLEARS (Caution) when its
 *    shunting access route to that shunting signal is set and proven, so the signal shows the route is set. That clearance is for a
 *    shunting movement only: any other train stops at the signal. The movement then stops at the shunting signal (Stop) until the
 *    shunting signal's own route is set, and only then (Proceed) enters the siding.
 */

import type { SignallingContext } from '../signalling/context';
import { isRouteProven } from '../signalling/aspects';
import type { Aspect, SignallingState } from '../signalling/types';
import type { Network } from '../topology/network';
import type { SectionEnd, SignalDef } from '../topology/types';
import type { Train } from './types';

/** Is this train making a shunting movement (an ECS train on its inbound leg, heading for the sidings)? */
export const shuntingMovement = (train: Train): boolean => train.ecs !== null && train.ecs.stage === 'inbound';

/** Does this signal apply to this train? An ordinary signal applies to everyone. A main-line shunting signal applies only to a shunting movement. */
export const signalApplies = (signal: SignalDef, train: Train): boolean => !signal.mainline || shuntingMovement(train);

const NONE: ReadonlySet<string> = new Set();
export const NO_SHUNT_AUTHORITY = NONE;

/**
 * The main signals whose route is a proven SHUNTING ACCESS route (main signal -> its associated AJ1/AJ4). Such a signal clears
 * (Caution) so that the shunting movement may leave it, but the route is for a shunting movement ONLY: any other train stops at it.
 * Empty for almost every state.
 */
export function shuntAuthorities(ctx: SignallingContext, sig: SignallingState, _aspects: Readonly<Record<string, Aspect>>): ReadonlySet<string> {
  let out: Set<string> | undefined;
  for (const s of ctx.net.signals.values()) {
    if (!s.associatedMain) continue;
    for (const m of s.associatedMain) {
      const routeId = sig.routes[m];
      const route = routeId === undefined ? undefined : ctx.route(routeId);
      if (route && route.shuntAccess && route.to === s.id && isRouteProven(sig, route)) (out ??= new Set()).add(m);
    }
  }
  return out ?? NONE;
}

const index = new WeakMap<Network, Map<string, SignalDef>>();

/** The signal standing at a section end that APPLIES to this train, or undefined. */
export function signalFor(net: Network, train: Train, e: SectionEnd): SignalDef | undefined {
  let m = index.get(net);
  if (!m) {
    m = new Map();
    for (const s of net.signals.values()) m.set(`${s.at.section}.${s.at.end}`, s);
    index.set(net, m);
  }
  const s = m.get(`${e.section}.${e.end}`);
  return s && signalApplies(s, train) ? s : undefined;
}

/**
 * Must this train stop at this signal? Danger is a stop. A signal cleared only for a shunting access route is a stop for every train
 * that is not making a shunting movement, whatever it shows.
 */
export const stopsAt = (aspects: Readonly<Record<string, Aspect>>, accessOnly: ReadonlySet<string>, train: Train, signal: SignalDef): boolean =>
  (aspects[signal.id] ?? 'red') === 'red' || (accessOnly.has(signal.id) && !shuntingMovement(train));
