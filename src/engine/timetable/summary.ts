/** Shift-end summary: computed only from what was recorded. Nothing is invented. */

import { delaysOf, ON_TIME_S, type ServiceActual, type ServiceSchedule } from './types';

export interface ShiftSummary {
  readonly shiftId: number;
  readonly scheduled: number;
  readonly completed: number;
  readonly cancelled: number;
  readonly failed: number;
  readonly class1: number;
  readonly class2: number;
  readonly class5: number;
  /** Completed services that actually stopped at a platform. */
  readonly stoppedAtStation: number;
  /** Averages in seconds over COMPLETED services that have the value; null if none applies. */
  readonly avgEntryDelayS: number | null;
  readonly avgArrivalDelayS: number | null;
  readonly avgDepartureDelayS: number | null;
  readonly avgExitDelayS: number | null;
  readonly onTime: number;
  readonly delayed: number;
  readonly mostDelayed: { readonly headcode: string; readonly delayS: number } | null;
  /** Sum of the late exit delays of completed services (early running does not offset lateness). */
  readonly totalDelayS: number;
}

const avg = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

export function summarise(shiftId: number, services: readonly ServiceSchedule[], actuals: ReadonlyMap<string, ServiceActual>): ShiftSummary {
  const done = services.filter((s) => actuals.get(s.id)?.exitS != null);
  const entry: number[] = [];
  const arrival: number[] = [];
  const departure: number[] = [];
  const exit: number[] = [];
  let stopped = 0;
  let onTime = 0;
  let delayed = 0;
  let total = 0;
  let worst: { headcode: string; delayS: number } | null = null;
  for (const s of done) {
    const a = actuals.get(s.id) as ServiceActual;
    const d = delaysOf(s, a);
    if (d.entry !== null) entry.push(d.entry);
    if (d.arrival !== null) {
      arrival.push(d.arrival);
      stopped++;
    }
    if (d.departure !== null) departure.push(d.departure);
    if (d.exit !== null) {
      exit.push(d.exit);
      if (d.exit < ON_TIME_S) onTime++;
      else delayed++;
      if (d.exit > 0) total += d.exit;
      if (d.exit >= ON_TIME_S && (worst === null || d.exit > worst.delayS)) worst = { headcode: s.headcode, delayS: d.exit };
    }
  }
  return {
    shiftId,
    scheduled: services.length,
    completed: done.length,
    cancelled: services.filter((s) => actuals.get(s.id)?.cancelledS != null).length,
    failed: services.filter((s) => actuals.get(s.id)?.failedReason != null).length,
    class1: services.filter((s) => s.trainClass === 1).length,
    class2: services.filter((s) => s.trainClass === 2).length,
    class5: services.filter((s) => s.trainClass === 5).length,
    stoppedAtStation: stopped,
    avgEntryDelayS: avg(entry),
    avgArrivalDelayS: avg(arrival),
    avgDepartureDelayS: avg(departure),
    avgExitDelayS: avg(exit),
    onTime,
    delayed,
    mostDelayed: worst,
    totalDelayS: total,
  };
}
