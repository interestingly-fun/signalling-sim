/**
 * Speed restrictions (Phase 8): the ONE place the limits are set.
 *
 * The movement engine never contains a speed. It asks `sectionLimit` (limits.ts), which reads this table.
 * These are illustrative game values, not real-world restrictions; change them here and everything
 * (the movement engine, the braking, the inspector, the tests) follows.
 *
 * Units: mph here because that is how limits are quoted; the engine converts to metres per second.
 */

import type { LineKind } from '../topology/types';

export interface SpeedConfig {
  /** Limit for a section by the kind of line it is. */
  readonly lineMph: Readonly<Record<LineKind, number>>;
  /** A section on the diverging leg of a set of points (the reverse leg) is limited to this, whatever line it is on. */
  readonly divergingMph: number;
  /**
   * Inside a siding (Phase 9 correction): the track of every siding declared in the topology (`NetworkDef.sidings`, so a new map's sidings
   * get it automatically) is limited to this, for every train and every class, entering, stabled movements and leaving. It applies
   * to the whole siding track and, by the usual rule, until the REAR of the train has left it. `sidingSections` adds further sections.
   * The siding lead and throat (the other SIDING-line sections) are NOT interior: they take `lineMph.SIDING` (and any other restriction),
   * so the approach is limited separately.
   */
  readonly sidingInteriorMph: number;
  readonly sidingSections: readonly string[];
  /** Individual sections with their own limit (the branch junction legs). The most restrictive applicable limit always wins. */
  readonly sectionMph: Readonly<Record<string, number>>;
  /** A train is flagged as overspeed only when it exceeds the permitted speed by more than this. */
  readonly overspeedToleranceMph: number;
  /**
   * Braking curves for speed restrictions are planned at this fraction of the train's service braking rate,
   * so the train always has a little in hand and follows the curve smoothly instead of chattering around it.
   */
  readonly brakePlanFactor: number;
}

export const SPEED_CONFIG: SpeedConfig = {
  // SIDING here is the siding lead and throat (the approach); the siding tracks themselves take `sidingInteriorMph`.
  lineMph: { UP: 125, DOWN: 125, BRANCH: 75, PLATFORM: 45, CROSSOVER: 40, LINK: 40, SIDING: 15 },
  divergingMph: 40,
  sidingInteriorMph: 5,
  sidingSections: [],
  sectionMph: { LA1: 40, LA2: 40, LA3: 40, LB1: 40, LBX: 40, LB2: 40 },
  overspeedToleranceMph: 1,
  brakePlanFactor: 0.9,
};
