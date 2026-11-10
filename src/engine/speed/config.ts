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
  /** Low-speed movements. Ashcombe has no sidings, so nothing is listed in `sidingSections`; the value is here for later layouts. */
  readonly sidingMph: number;
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
  lineMph: { UP: 125, DOWN: 125, BRANCH: 75, PLATFORM: 45, CROSSOVER: 40, LINK: 40 },
  divergingMph: 40,
  sidingMph: 15,
  sidingSections: [],
  sectionMph: { LA1: 40, LA2: 40, LA3: 40, LB1: 40, LBX: 40, LB2: 40 },
  overspeedToleranceMph: 1,
  brakePlanFactor: 0.9,
};
