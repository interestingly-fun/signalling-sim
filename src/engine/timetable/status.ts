/** Live status and delay of a scheduled service, derived from facts only (the train and the recorded actual times). */

import type { Train } from '../trains';
import { delaysOf, ON_TIME_S, type ServiceActual, type ServiceSchedule } from './types';

export type ServiceStatus =
  | 'Expected'
  | 'Ready to enter'
  | 'Waiting for entry'
  | 'Delayed'
  | 'Entered area'
  | 'Approaching station'
  | 'At platform'
  | 'Ready to depart'
  | 'Departed station'
  | 'En route to exit'
  | 'Completed'
  | 'Cancelled'
  | 'Failed';

/** After this long at the boundary a train that has not been able to enter is shown as Delayed. */
const DELAYED_WAITING_S = ON_TIME_S;

export function deriveStatus(s: ServiceSchedule, a: ServiceActual, train: Train | null, nowS: number): ServiceStatus {
  if (a.failedReason !== null) return 'Failed';
  if (a.cancelledS !== null) return 'Cancelled';
  if (a.exitS !== null) return 'Completed';
  if (a.trainId === null || train === null) return nowS < s.entryS ? 'Expected' : 'Ready to enter';
  if (a.entryS === null) {
    if (nowS - s.entryS >= DELAYED_WAITING_S) return 'Delayed';
    return nowS - (a.createdS ?? nowS) < 2 && !train.holdReason.startsWith('Waiting to enter') ? 'Ready to enter' : 'Waiting for entry';
  }
  const stop = train.stop;
  if (s.stops && stop) {
    if (stop.phase === 'pending') return train.status === 'approaching platform' || (train.status === 'braking' && train.limit.kind === 'platform') ? 'Approaching station' : 'Entered area';
    if (stop.phase === 'dwelling') return 'At platform';
    if (stop.phase === 'done') return a.departureS === null ? 'Ready to depart' : 'Departed station';
    return 'En route to exit';
  }
  return a.passS !== null ? 'En route to exit' : 'Entered area';
}

/**
 * Delay right now, in seconds: the delay at the latest event that has happened,
 * raised to how overdue the next scheduled event already is. null before the
 * service is due. Never reset: a late train stays late unless it really recovers.
 */
export function currentDelayS(s: ServiceSchedule, a: ServiceActual, nowS: number): number | null {
  if (a.cancelledS !== null || a.failedReason !== null) return null;
  const d = delaysOf(s, a);
  if (a.exitS !== null) return d.exit;
  const next: [number | null, number | null][] = [
    [s.entryS, a.entryS],
    [s.arrivalS, a.arrivalS],
    [s.departureS, a.departureS],
    [s.exitS, a.exitS],
  ];
  let last: number | null = null;
  for (const [sched, act] of next) {
    if (sched === null) continue;
    if (act !== null) last = act - sched;
    else {
      const overdue = nowS - sched;
      if (overdue > 0) last = Math.max(last ?? 0, overdue);
      break;
    }
  }
  return last;
}
