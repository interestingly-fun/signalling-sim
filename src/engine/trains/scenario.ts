/**
 * The single test train and its journey. Phase 3 has exactly one train; this
 * file only names it and gives it a movement model. Nothing here is a timetable.
 */

import type { TrainSpec } from './types';

/** Class 1 express: runs through without stopping. All values are configurable. */
export const EXPRESS_DEFAULTS = {
  trainClass: 1,
  lengthM: 160,
  maxSpeedMs: 30, // about 108 km/h / 67 mph: the diagram is only a couple of kilometres long
  accelerationMs2: 0.8,
  serviceBrakeMs2: 0.9,
  emergencyBrakeMs2: 1.5,
  stopMarginM: 10,
} as const;

export interface JourneyOption {
  readonly id: string;
  readonly label: string;
  readonly origin: string;
  readonly destination: string;
}

/**
 * Journeys the test train can make. The first is the one asked for:
 * Northbridge to Westford. In this layout that journey runs WESTBOUND on the
 * DOWN main (the UP main is eastbound only), so the second option is the
 * eastbound UP-main equivalent. Both run straight through, never into a platform loop.
 */
export const JOURNEYS: readonly JourneyOption[] = [
  { id: 'northbridge-westford', label: 'Northbridge → Westford (westbound, DOWN main)', origin: 'N-IN', destination: 'W-OUT' },
  { id: 'westford-northbridge', label: 'Westford → Northbridge (eastbound, UP main)', origin: 'W-IN', destination: 'N-OUT' },
  { id: 'merefield-northbridge', label: 'Merefield → Northbridge (branch, then UP main)', origin: 'M-IO', destination: 'N-OUT' },
  { id: 'northbridge-merefield', label: 'Northbridge → Merefield (DOWN main, then branch)', origin: 'N-IN', destination: 'M-IO' },
];

export function testTrainSpec(journey: JourneyOption = JOURNEYS[0] as JourneyOption, overrides: Partial<TrainSpec> = {}): TrainSpec {
  return { headcode: '1G42', ...EXPRESS_DEFAULTS, origin: journey.origin, destination: journey.destination, ...overrides };
}
