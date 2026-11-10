/**
 * THE rolling-stock database (Phase 7). Every model-specific number in the simulator comes from here.
 *
 * Values are simulator values, chosen to be internally consistent and to make trains feel different,
 * not exact specifications. To change a train, edit this file; the movement engine is generic.
 *
 * Rules of thumb used:
 *   - length = cars x car length (about 23 m for a mainline vehicle, 15-20 m for older regional units)
 *   - a longer formation of a model accelerates a little more slowly and brakes a little less sharply
 *   - electric multiple units accelerate and brake hardest; heavy diesel and bi-mode units least
 *   - 'accelTaper' is the share of the standing acceleration left at maximum speed
 */

import type { ModelDef } from './types';

export const MPH_TO_MS = 0.44704;
export const mphToMs = (mph: number): number => mph * MPH_TO_MS;
export const msToMph = (ms: number): number => ms / MPH_TO_MS;

export const ROLLING_STOCK: readonly ModelDef[] = [
  {
    id: '800',
    name: 'Class 800',
    description: 'Bi-mode intercity unit',
    traction: 'bi-mode',
    maxSpeedMph: 125,
    accelTaper: 0.3,
    classes: [1],
    class1Variant: 'express',
    weight: 3,
    formations: [
      { id: '5-car', cars: 5, lengthM: 130, accelerationMs2: 0.7, serviceBrakeMs2: 0.8, emergencyBrakeMs2: 1.3, weight: 1 },
      { id: '9-car', cars: 9, lengthM: 234, accelerationMs2: 0.58, serviceBrakeMs2: 0.74, emergencyBrakeMs2: 1.2, weight: 1 },
    ],
  },
  {
    id: '221',
    name: 'Class 221',
    description: 'Diesel tilting intercity unit',
    traction: 'diesel',
    maxSpeedMph: 125,
    accelTaper: 0.25,
    classes: [1],
    class1Variant: 'express',
    weight: 2,
    formations: [
      { id: '4-car', cars: 4, lengthM: 92, accelerationMs2: 0.52, serviceBrakeMs2: 0.72, emergencyBrakeMs2: 1.2, weight: 1 },
      { id: '5-car', cars: 5, lengthM: 115, accelerationMs2: 0.46, serviceBrakeMs2: 0.68, emergencyBrakeMs2: 1.15, weight: 1 },
    ],
  },
  {
    id: '390',
    name: 'Class 390',
    description: 'Electric tilting intercity unit',
    traction: 'electric',
    maxSpeedMph: 125,
    accelTaper: 0.35,
    classes: [1],
    class1Variant: 'express',
    weight: 2,
    formations: [
      { id: '9-car', cars: 9, lengthM: 215, accelerationMs2: 0.64, serviceBrakeMs2: 0.82, emergencyBrakeMs2: 1.3, weight: 1 },
      { id: '11-car', cars: 11, lengthM: 263, accelerationMs2: 0.56, serviceBrakeMs2: 0.76, emergencyBrakeMs2: 1.25, weight: 1 },
    ],
  },
  {
    id: '142',
    name: 'Class 142',
    description: 'Light diesel railbus',
    traction: 'diesel',
    maxSpeedMph: 75,
    accelTaper: 0.2,
    classes: [2],
    class1Variant: 'express',
    weight: 1,
    formations: [{ id: '2-car', cars: 2, lengthM: 31, accelerationMs2: 0.55, serviceBrakeMs2: 0.9, emergencyBrakeMs2: 1.3, weight: 1 }],
  },
  {
    id: '150',
    name: 'Class 150',
    description: 'Diesel regional unit',
    traction: 'diesel',
    maxSpeedMph: 75,
    accelTaper: 0.22,
    classes: [2],
    class1Variant: 'express',
    weight: 2,
    formations: [
      { id: '2-car', cars: 2, lengthM: 40, accelerationMs2: 0.66, serviceBrakeMs2: 0.92, emergencyBrakeMs2: 1.35, weight: 2 },
      { id: '3-car', cars: 3, lengthM: 60, accelerationMs2: 0.6, serviceBrakeMs2: 0.9, emergencyBrakeMs2: 1.3, weight: 1 },
    ],
  },
  {
    id: '170',
    name: 'Class 170',
    description: 'Diesel regional express unit',
    traction: 'diesel',
    maxSpeedMph: 100,
    accelTaper: 0.25,
    classes: [2],
    class1Variant: 'express',
    weight: 3,
    formations: [
      { id: '2-car', cars: 2, lengthM: 47, accelerationMs2: 0.72, serviceBrakeMs2: 0.9, emergencyBrakeMs2: 1.35, weight: 2 },
      { id: '3-car', cars: 3, lengthM: 71, accelerationMs2: 0.64, serviceBrakeMs2: 0.88, emergencyBrakeMs2: 1.3, weight: 1 },
    ],
  },
  {
    id: '175',
    name: 'Class 175',
    description: 'Diesel regional express unit',
    traction: 'diesel',
    maxSpeedMph: 100,
    accelTaper: 0.25,
    classes: [2],
    class1Variant: 'express',
    weight: 2,
    formations: [
      { id: '2-car', cars: 2, lengthM: 47, accelerationMs2: 0.68, serviceBrakeMs2: 0.88, emergencyBrakeMs2: 1.3, weight: 1 },
      { id: '3-car', cars: 3, lengthM: 71, accelerationMs2: 0.6, serviceBrakeMs2: 0.86, emergencyBrakeMs2: 1.25, weight: 1 },
    ],
  },
  {
    id: '387',
    name: 'Class 387',
    description: 'Electric suburban and regional unit',
    traction: 'electric',
    maxSpeedMph: 110,
    accelTaper: 0.3,
    classes: [1, 2],
    class1Variant: 'flexible',
    weight: 2,
    formations: [{ id: '4-car', cars: 4, lengthM: 80, accelerationMs2: 0.95, serviceBrakeMs2: 1.0, emergencyBrakeMs2: 1.5, weight: 1 }],
  },
  {
    id: '350',
    name: 'Class 350',
    description: 'Electric outer-suburban unit',
    traction: 'electric',
    maxSpeedMph: 110,
    accelTaper: 0.3,
    classes: [1, 2],
    class1Variant: 'flexible',
    weight: 1,
    formations: [{ id: '4-car', cars: 4, lengthM: 84, accelerationMs2: 0.85, serviceBrakeMs2: 0.95, emergencyBrakeMs2: 1.45, weight: 1 }],
  },
];
