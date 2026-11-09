/**
 * Signalling (interlocking) types.
 *
 * Everything here is built on the Phase 1 topology: routes are the entries of
 * the derived route table, point positions and occupancy live in the Phase 1
 * NetworkState. Nothing in this folder knows about the screen.
 */

import type { NetworkState } from '../state/state';
import type { DerivedRoute } from '../topology/types';

/** Simplified four-aspect signalling: Green > Double Yellow > Single Yellow > Red. */
export type Aspect = 'red' | 'yellow' | 'double-yellow' | 'green';

/**
 * The complete interlocking state. Immutable: every operation returns a new
 * object, and a refused operation returns the SAME object it was given.
 *
 * `routes`, `sectionLocks` and `pointLocks` are only ever changed together, by
 * lockRoute / unlockRoute in locks.ts, so they cannot disagree.
 */
export interface SignallingState {
  /** Point positions and (test) occupancy: the Phase 1 state, unchanged. */
  readonly network: NetworkState;
  /** Established routes: entrance signal ID -> derived route ID. A signal has at most one. */
  readonly routes: Readonly<Record<string, string>>;
  /** Track section ID -> ID of the route that has reserved it. */
  readonly sectionLocks: Readonly<Record<string, string>>;
  /** Point ID -> ID of the route that has locked it. */
  readonly pointLocks: Readonly<Record<string, string>>;
  /**
   * Automatic signals the operator has forced to Danger. Only forced signals are
   * listed; any other automatic signal is AUTOMATIC. This is a separate record:
   * it never changes occupancy, routes, locks or points, and removing an entry
   * lets the normal automatic calculation show again.
   */
  readonly signalOverrides: Readonly<Record<string, 'FORCED_DANGER'>>;
  /**
   * Routes whose entrance signal the train has PASSED. The signal has returned to
   * Red and no longer owns the route, but the sections and points the train has
   * not yet cleared stay locked, owned by the route ID, until the rear of the
   * train frees them one by one (sectional release, locks.ts). Empty when no
   * train is running over a route.
   */
  readonly residual: Readonly<Record<string, true>>;
}

/** Operator control of an automatic signal. */
export type SignalOverride = 'AUTOMATIC' | 'FORCED_DANGER';

export type RejectionCode =
  | 'NO_SUCH_MOVEMENT'
  | 'NOT_MANUAL'
  | 'ALREADY_SET'
  | 'SECTION_OCCUPIED'
  | 'SECTION_LOCKED'
  | 'CROSSING_CONFLICT'
  | 'OPPOSING_MOVEMENT'
  | 'POINT_LOCKED'
  | 'POINT_OCCUPIED'
  | 'NOT_ESTABLISHED'
  | 'CANCEL_OCCUPIED'
  | 'NO_SUCH_SIGNAL'
  | 'NOT_AUTOMATIC';

/** Why an operation was refused. `message` is ready to show to the signaller. */
export interface Rejection {
  readonly code: RejectionCode;
  readonly message: string;
  /** The network object the refusal is about (a section, point or signal ID). */
  readonly subject?: string;
  /** The route that is in the way, when there is one. */
  readonly owner?: string;
}

export type RouteResult =
  | {
      readonly ok: true;
      readonly state: SignallingState;
      readonly route: DerivedRoute;
      /** Points that had to be moved to set the route. */
      readonly pointsMoved: readonly string[];
      readonly message: string;
    }
  | { readonly ok: false; readonly state: SignallingState; readonly rejection: Rejection };

export type CancelResult =
  | { readonly ok: true; readonly state: SignallingState; readonly route: DerivedRoute; readonly message: string }
  | { readonly ok: false; readonly state: SignallingState; readonly rejection: Rejection };

export type OverrideResult =
  | { readonly ok: true; readonly state: SignallingState; readonly message: string }
  | { readonly ok: false; readonly state: SignallingState; readonly rejection: Rejection };

export type PointMoveResult =
  | { readonly ok: true; readonly state: SignallingState; readonly message: string }
  | { readonly ok: false; readonly state: SignallingState; readonly rejection: Rejection };
