/**
 * Train classes (Phase 4): what each kind of train may do and its default
 * movement model. Operating rules live here, not in the UI.
 *
 *   Class 1  express   mainline only, never stops, never enters a platform loop
 *                      or the branch
 *   Class 2  regional  UP/DOWN main, branch and platform loops; stops at its
 *                      assigned platform and dwells, never stops on the main
 *                      line for a station stop
 *   Class 5  ECS       mains and loops; may run through or stop at a platform
 *
 * Speeds are metres per second. `entrySpeedMs` is the speed at the boundary.
 */

import { isFlexibleClass1, stockPerformance, type StockRef } from '../rollingstock';
import type { LineKind } from '../topology/types';
import { EXPRESS_DEFAULTS } from './scenario';
import type { TrainSpec } from './types';

export type TrainClassId = 1 | 2 | 5;

export interface ClassProfile {
  readonly trainClass: TrainClassId;
  readonly name: string;
  readonly description: string;
  readonly lengthM: number;
  readonly maxSpeedMs: number;
  readonly entrySpeedMs: number;
  readonly defaultDwellS: number;
  /** May this class be given a station stop? */
  readonly canStop: boolean;
  /** Track kinds it may enter. A section of any other kind is a barrier, like a Red signal. */
  readonly lines: readonly LineKind[];
}

export const CLASS_PROFILES: Readonly<Record<TrainClassId, ClassProfile>> = {
  1: {
    trainClass: 1,
    name: 'Express',
    description: 'Mainline only. Never stops. Never uses platform loops or the branch.',
    lengthM: 160,
    maxSpeedMs: EXPRESS_DEFAULTS.maxSpeedMs,
    entrySpeedMs: 25,
    defaultDwellS: 0,
    canStop: false,
    lines: ['UP', 'DOWN', 'CROSSOVER', 'LINK'],
  },
  2: {
    trainClass: 2,
    name: 'Regional',
    description: 'Main lines, branch and platform loops. Stops at its assigned platform.',
    lengthM: 100,
    maxSpeedMs: 25,
    entrySpeedMs: 18,
    defaultDwellS: 40,
    canStop: true,
    lines: ['UP', 'DOWN', 'BRANCH', 'PLATFORM', 'CROSSOVER', 'LINK'],
  },
  5: {
    trainClass: 5,
    name: 'ECS',
    description: 'Empty coaching stock. Main lines and platform loops; may run through or stop.',
    lengthM: 80,
    maxSpeedMs: 20,
    entrySpeedMs: 15,
    defaultDwellS: 20,
    canStop: true,
    lines: ['UP', 'DOWN', 'PLATFORM', 'CROSSOVER', 'LINK'],
  },
};

export const TRAIN_CLASSES: readonly TrainClassId[] = [1, 2, 5];

export const classProfile = (trainClass: number): ClassProfile => CLASS_PROFILES[trainClass as TrainClassId] ?? CLASS_PROFILES[2];

/** What a train may do: the track kinds it may enter and whether it may be given a station stop. */
export interface Permissions {
  readonly lines: readonly LineKind[];
  readonly canStop: boolean;
}

/**
 * Operating permissions for a class, and (Phase 7) for the model working it. Class 2 and 5 rules never depend on
 * the model. A model with the 'flexible' Class 1 variant (Class 387, 350) working as Class 1 keeps the mainline
 * rules and may also use the branch and platforms: it calls at Ashcombe when the timetable says so.
 */
export function permissionsFor(trainClass: number, model?: string): Permissions {
  if (trainClass === 1 && isFlexibleClass1(model)) return { lines: CLASS_PROFILES[2].lines, canStop: true };
  const p = classProfile(trainClass);
  return { lines: p.lines, canStop: p.canStop };
}

/** May a train of this class (and model, if known) run on this kind of track? */
export const classAllowsLine = (trainClass: number, line: LineKind, model?: string): boolean => permissionsFor(trainClass, model).lines.includes(line);

/** Movement spec for a train of the given class. Identity (headcode, boundaries) is supplied by the caller. */
export function specForClass(trainClass: TrainClassId, identity: Pick<TrainSpec, 'headcode' | 'origin' | 'destination'> & Partial<TrainSpec>): TrainSpec {
  const p = CLASS_PROFILES[trainClass];
  return {
    ...EXPRESS_DEFAULTS,
    trainClass,
    lengthM: p.lengthM,
    maxSpeedMs: p.maxSpeedMs,
    entrySpeedMs: p.entrySpeedMs,
    stop: null,
    ...identity,
  };
}

/**
 * Movement spec for a train of the given operating class made up as the given model and formation. Length,
 * maximum speed, acceleration and braking come from the rolling-stock database; the entry speed is the class's
 * normal entry speed, limited to three quarters of the model's top speed.
 */
export function specForStock(trainClass: TrainClassId, stock: StockRef, identity: Pick<TrainSpec, 'headcode' | 'origin' | 'destination'> & Partial<TrainSpec>): TrainSpec {
  const p = CLASS_PROFILES[trainClass];
  const perf = stockPerformance(stock);
  return {
    ...EXPRESS_DEFAULTS,
    trainClass,
    stock,
    ...perf,
    entrySpeedMs: Math.min(p.entrySpeedMs, 0.75 * perf.maxSpeedMs),
    stop: null,
    ...identity,
  };
}
