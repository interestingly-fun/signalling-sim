/**
 * Train performance (Phase 7): how quickly a train can gain speed.
 *
 * Acceleration falls linearly with speed from the standing-start rate to `accelTaper` times that rate at
 * maximum speed, like real traction. It is a pure function of the spec and the current speed, so it is
 * deterministic and independent of the frame rate. Braking is a constant service rate (see step.ts).
 */

import type { TrainSpec } from './types';

/** Acceleration (m/s²) the train can apply at speed `v` (m/s). Always positive. */
export function accelerationAt(spec: Pick<TrainSpec, 'accelerationMs2' | 'accelTaper' | 'maxSpeedMs'>, v: number): number {
  const taper = spec.accelTaper ?? 1;
  if (taper >= 1 || spec.maxSpeedMs <= 0) return spec.accelerationMs2;
  const share = Math.min(1, Math.max(0, v / spec.maxSpeedMs));
  return spec.accelerationMs2 * (1 - (1 - taper) * share);
}
