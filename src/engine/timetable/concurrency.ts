/**
 * How much of a timetable is actually concurrent (Phase 8): how many services are inside the controlled area at
 * once. A service is in the area from its scheduled entry until its rear has cleared the exit boundary.
 * Used by the generator (to aim for overlap) and by the tests; it never decides what is SAFE (validate.ts does).
 */

import type { ServiceSchedule } from './types';

export interface Overlap {
  readonly a: string;
  readonly b: string;
  readonly fromS: number;
  readonly toS: number;
}

export interface ConcurrencyStats {
  /** The most services present at the same moment. */
  readonly maxPresent: number;
  /** Seconds with two or more services present. */
  readonly multiS: number;
  /** Seconds with three or more services present. */
  readonly threePlusS: number;
  /** Pairs of services whose times in the area overlap. */
  readonly pairs: readonly Overlap[];
}

export function concurrencyStats(services: readonly Pick<ServiceSchedule, 'headcode' | 'entryS' | 'exitS'>[]): ConcurrencyStats {
  const events: { t: number; d: number }[] = [];
  for (const s of services) {
    events.push({ t: s.entryS, d: 1 }, { t: s.exitS, d: -1 });
  }
  events.sort((x, y) => x.t - y.t || x.d - y.d);
  let n = 0;
  let max = 0;
  let multi = 0;
  let three = 0;
  let last = events[0]?.t ?? 0;
  for (const e of events) {
    const dt = e.t - last;
    if (n >= 2) multi += dt;
    if (n >= 3) three += dt;
    n += e.d;
    max = Math.max(max, n);
    last = e.t;
  }
  const pairs: Overlap[] = [];
  for (let i = 0; i < services.length; i++) {
    for (let j = i + 1; j < services.length; j++) {
      const a = services[i] as (typeof services)[number];
      const b = services[j] as (typeof services)[number];
      const from = Math.max(a.entryS, b.entryS);
      const to = Math.min(a.exitS, b.exitS);
      if (to > from) pairs.push({ a: a.headcode, b: b.headcode, fromS: from, toS: to });
    }
  }
  return { maxPresent: max, multiS: multi, threePlusS: three, pairs };
}
