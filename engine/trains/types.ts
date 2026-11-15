/**
 * Train types (Phase 3). Pure data. No React, DOM or coordinates.
 *
 * A train moves in METRES along a PATH: the list of sections it has entered,
 * each with the end it came in through. Distances are measured from the start
 * of the first section. `frontM` is the front of the train; the rear is
 * `frontM - lengthM`, independently of the front. Everything else (which
 * sections are occupied, where to draw it) is derived from those two numbers.
 */

import type { StockRef } from '../rollingstock';
import type { LimitSegment, NextRestriction } from '../speed';
import type { EndId } from '../topology/types';

/** Configurable movement model and identity of a train. */
export interface TrainSpec {
  readonly headcode: string;
  /** Train class, 1 = express. Descriptive in Phase 3. */
  readonly trainClass: number;
  readonly lengthM: number;
  readonly maxSpeedMs: number;
  readonly accelerationMs2: number;
  /**
   * Fraction of `accelerationMs2` still available at `maxSpeedMs` (Phase 7). The rate falls linearly with speed
   * between the two. Absent or 1: a constant rate (the Phase 3 behaviour).
   */
  readonly accelTaper?: number;
  /** Normal braking rate. The braking curve to a stop is planned with this. */
  readonly serviceBrakeMs2: number;
  /** Strongest braking rate, used only if the planned curve is violated (e.g. a signal turns Red close by). */
  readonly emergencyBrakeMs2: number;
  /** The train plans to stop this far short of a Red signal or other barrier. */
  readonly stopMarginM: number;
  /** The physical model and formation this performance came from (Phase 7). Absent only on generic test trains. */
  readonly stock?: StockRef;
  /** Boundary the train enters the area through. */
  readonly origin: string;
  /** Boundary the train is expected to leave through. */
  readonly destination: string;
  /**
   * Speed (m/s) the train has when it crosses the boundary into the area.
   * Absent or 0: the Phase 3 behaviour, a train standing on its entry section.
   * Above 0: the train waits just OUTSIDE the boundary and is admitted at this speed.
   */
  readonly entrySpeedMs?: number;
  /**
   * TEST ONLY (Phase 8): the driver does not slow for speed restrictions, so a train can be made to exceed them and
   * the overspeed warning can be seen. Signals are still obeyed.
   */
  readonly ignoreRestrictions?: boolean;
  /** Station stop: the platform to stop at and how long to dwell (simulated seconds). Absent: runs through. */
  readonly stop?: StopRequest | null;
}

/** What the operator asked for: stop at this platform for this long. */
export interface StopRequest {
  /** Platform ID, e.g. PLAT1. */
  readonly platform: string;
  /** Dwell time in simulated seconds, counted from the moment the train has stopped at the platform. */
  readonly dwellS: number;
}

/**
 * Where the stop has got to.
 *   pending  : on the way to the platform, not yet stopped there
 *   dwelling : stopped at the platform, timer running
 *   done     : dwell finished; the train may leave when the signals allow
 *   departed : the rear has left the platform; the platform is free again
 */
export type StopPhase = 'pending' | 'dwelling' | 'done' | 'departed';

export interface StopState {
  /** The platform the train is ACTUALLY stopping at: the one the signaller's route takes it to. */
  readonly platform: string;
  /** The platform the timetable planned. Never changes; compare with `platform` to see a reassignment. */
  readonly scheduledPlatform: string;
  /** Platform section ID. */
  readonly section: string;
  readonly dwellS: number;
  readonly remainingS: number;
  readonly phase: StopPhase;
}

/** What the train is doing, in operating terms (as opposed to the kinematic MovementState). */
export type OperationalStatus =
  | 'waiting to enter'
  | 'approaching'
  | 'running'
  | 'braking'
  | 'stopped at signal'
  | 'approaching platform'
  | 'stopped at platform'
  | 'dwelling'
  | 'ready to depart'
  | 'reversing'
  | 'stabled'
  | 'departing'
  | 'exiting'
  | 'completed';

/** One section of the path and the end through which the train entered it. */
export interface PathStep {
  readonly section: string;
  readonly enterEnd: EndId;
}

export type MovementState = 'ready' | 'accelerating' | 'cruising' | 'braking' | 'stopped' | 'finished';

/** What currently limits how far the train may go. */
export type LimitKind = 'signal' | 'points' | 'occupied' | 'horizon' | 'exit' | 'platform' | 'restricted' | 'buffer';

/** Speed information for the performance inspector and the overspeed warning (Phase 8). Information only. */
export interface SpeedInfo {
  /** The speed permitted at the front now: the most restrictive of the model maximum and the restricted sections the train occupies. */
  readonly permittedMs: number;
  /** What sets it, e.g. "Diverging route 40 mph". */
  readonly permittedLabel: string;
  /** Above the permitted speed by more than the tolerance. A warning only: ordinary limits are never enforced by braking. */
  readonly overspeed: boolean;
  /** The nearest lower restriction ahead, with the braking distance needed to meet it. */
  readonly next: NextRestriction | null;
  /** Speed the train is planning to be at (the braking envelope for restrictions ahead). */
  readonly envelopeMs: number;
}

export interface Limit {
  readonly kind: LimitKind;
  /** Furthest distance the FRONT may reach along the path; Infinity when nothing limits it. */
  readonly limitM: number;
  /** Signal, point or section that causes the limit. */
  readonly subject?: string;
  /** Stand this far short of the limit instead of the train's usual margin (a platform stopping position). */
  readonly marginM?: number;
  /** The speed-restricted stretches of the sections ahead the scan walked through (Phase 8). */
  readonly segments?: readonly LimitSegment[];
}

// ---------------------------------------------------------------------------
// Phase 9: reversal and the ECS siding cycle
// ---------------------------------------------------------------------------

/**
 * The physical stages of a reversal (a driver changing ends at a standstill):
 *   approaching : running up to the reversal point (the stop signal, or the buffer stops of a siding)
 *   braking     : slowing for it
 *   awaiting    : stopped; the train must be wholly inside the bay and standing before it may begin
 *   reversing   : the driver is changing ends (a fixed time, the train does not move)
 *   ready       : the train now faces the other way and waits for authority to leave
 */
export type ReversalPhase = 'approaching' | 'braking' | 'awaiting' | 'reversing' | 'ready';

export interface ReversalState {
  /** A reversal bay ID, or a siding ID when the train changes ends at the buffer stops of its siding. */
  readonly bay: string;
  readonly kind: 'bay' | 'siding';
  readonly phase: ReversalPhase;
  /** Seconds of changing ends still to go (only while `reversing`). */
  readonly remainingS: number;
  /** Why the reversal cannot start, or ''. */
  readonly note: string;
}

/** The service an ECS train becomes when it leaves its siding. */
export interface OnwardService {
  readonly headcode: string;
  readonly trainClass: 1 | 2 | 5;
  /** Exit boundary. */
  readonly destination: string;
}

/**
 *   inbound   : on its way to the siding (possibly reversing on the way)
 *   stabled   : wholly inside the siding, standing; the stabling timer runs
 *   preparing : stabling over: the onward service is set up and the train changes ends
 *   ready     : facing out, waiting for the exit signal
 *   leaving   : the front has passed the exit signal; the rear is still in the siding
 *   onward    : out of the siding, running its onward service
 */
export type EcsStage = 'inbound' | 'stabled' | 'preparing' | 'ready' | 'leaving' | 'onward';

/**
 * Northbridge: a terminating service. The same physical train arrives at a terminus platform, stops, dwells, changes ends
 * (never while moving) and leaves through the platform's departure signal, usually under a new headcode.
 *   inbound   : on its way to (or standing in) the terminus platform
 *   reversing : standing, changing ends
 *   ready     : changed ends, waiting for the departure route and signal
 *   leaving   : front past the departure signal, rear still in the platform
 *   done      : the platform is clear
 */
export type TerminalStage = 'inbound' | 'reversing' | 'ready' | 'leaving' | 'done';
export interface TerminalJob {
  readonly stage: TerminalStage;
  readonly incomingHeadcode: string;
  /** Planned terminal (Northbridge platform id); the platform actually used is the one the signaller's route reaches. */
  readonly terminal: string;
  readonly onward: OnwardService;
  /** Stops still to make once the current stop has been left (the terminal stop, then an optional westbound call). */
  readonly stops: readonly { readonly platform: string; readonly dwellS: number }[];
  readonly approachPlan: readonly string[];
  readonly departurePlan: readonly string[];
  readonly remainingS: number;
  readonly reversals: number;
  readonly note: string;
  /** The terminus platform section the train actually stands in (set when it begins to change ends). */
  readonly at?: string;
}

/** One ECS siding cycle, carried by the physical train through all its stages. */
export interface EcsJob {
  readonly incomingHeadcode: string;
  readonly siding: string;
  /** Reversal bays still to be used on the way (in order). Before the siding: the approach; after it: the departure. */
  readonly bayQueue: readonly string[];
  /** The departure's reversal bays, loaded into `bayQueue` once the train has changed ends in the siding. */
  readonly departureBays: readonly string[];
  /** Movement IDs of the approach and of the departure (informational: what the signaller sets). */
  readonly approachPlan: readonly string[];
  readonly departurePlan: readonly string[];
  readonly stablingS: number;
  readonly stablingRemainingS: number;
  readonly onward: OnwardService;
  readonly stage: EcsStage;
  readonly reversal: ReversalState | null;
  /** Reversals completed so far (bays and the siding). */
  readonly reversals: number;
  /** Why the train cannot yet prepare or leave, or ''. */
  readonly note: string;
}

export interface Train {
  readonly id: string;
  readonly spec: TrainSpec;
  /** Sections entered so far, in order. A section stays here after it has been left. */
  readonly path: readonly PathStep[];
  /** Cumulative end distance of each path step (parallel to `path`). */
  readonly ends: readonly number[];
  /** Distance of the front of the train from the start of path[0]. */
  readonly frontM: number;
  readonly speedMs: number;
  /** False until the operator starts the train. */
  readonly started: boolean;
  /** Boundary the front has crossed out of the area, once it has. */
  readonly exited: string | null;
  /** Established routes the front has passed the entrance of; released when the rear clears them. */
  readonly heldRoutes: readonly string[];
  /** All sections cleared and out of the area. */
  readonly finished: boolean;
  readonly state: MovementState;
  /** Speed the braking curve / line speed allows at the end of the last step. */
  readonly targetSpeedMs: number;
  readonly limit: Limit;
  /** Plain-English reason the train is standing, or ''. */
  readonly holdReason: string;
  /** Operating status (Phase 4). */
  readonly status: OperationalStatus;
  /** Station stop in progress, or null when the train runs through. */
  readonly stop: StopState | null;
  /** Permitted speed, upcoming restriction and overspeed warning (Phase 8). */
  readonly speedInfo: SpeedInfo;
  /** Movement IDs (signal-to-signal routes) of the service plan the signaller is expected to set. Informational. */
  readonly plan: readonly string[];
  /** Phase 9: the ECS siding cycle this train is working, or null for an ordinary service. */
  readonly ecs: EcsJob | null;
  /** Northbridge: the terminating service this train works, or null/absent. */
  readonly terminal?: TerminalJob | null;
}

export type TrainEvent =
  | { readonly kind: 'entered'; readonly section: string; readonly text: string }
  | { readonly kind: 'cleared'; readonly section: string; readonly text: string }
  | { readonly kind: 'passed-signal'; readonly signal: string; readonly text: string }
  | { readonly kind: 'stopped'; readonly text: string }
  | { readonly kind: 'moving'; readonly text: string }
  | { readonly kind: 'released'; readonly route: string; readonly text: string }
  | { readonly kind: 'protection-stop'; readonly text: string }
  | { readonly kind: 'admitted'; readonly text: string }
  | { readonly kind: 'platform-changed'; readonly from: string; readonly to: string; readonly text: string }
  | { readonly kind: 'arrived'; readonly platform: string; readonly text: string }
  | { readonly kind: 'ready'; readonly platform: string; readonly text: string }
  | { readonly kind: 'departed'; readonly platform: string; readonly text: string }
  | { readonly kind: 'exited'; readonly text: string }
  | { readonly kind: 'overspeed'; readonly text: string }
  | { readonly kind: 'overspeed-ended'; readonly text: string }
  | { readonly kind: 'finished'; readonly text: string }
  /** Phase 9: a step of the ECS siding cycle or of a reversal. `what` says which (the event log uses it to group them). */
  | { readonly kind: 'ecs'; readonly what: EcsEventKind; readonly text: string };

export type EcsEventKind =
  | 'approaching-reversal'
  | 'stopped-for-reversal'
  | 'reversal-complete'
  | 'entering-siding'
  | 'stabled'
  | 'stabling-complete'
  | 'new-headcode'
  | 'new-class'
  | 'authorised'
  | 'leaving-siding'
  | 'siding-released'
  | 'blocked';
