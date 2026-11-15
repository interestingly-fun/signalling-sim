/**
 * Timetable data model (Phase 5).
 *
 * Pure data: nothing here moves a train or touches the interlocking. All times
 * are SIMULATED SECONDS since the start of the shift (shift time). The shift
 * starts at `startClockS` seconds after midnight (08:00:00 = 28800), which is
 * only used to print a time of day.
 *
 * Boundary times and station times are different things and are kept apart:
 *   entryS      the train reaches its external boundary (front crosses it)
 *   arrivalS    the train has STOPPED at its platform at Ashcombe Junction
 *   departureS  the train leaves the platform
 *   passS       a non-stopping train passes through the station area
 *   exitS       the train has COMPLETELY left the area (rear clear of the boundary)
 */

import type { StockRef } from '../rollingstock';

export type LineName = 'UP' | 'DOWN' | 'BRANCH';

/**
 * Phase 9: an ECS siding cycle. The SAME physical train is timetabled once: it enters as the Class 5 ECS `headcode`,
 * reverses where the topology and its length allow, stables in `siding` for `stablingS`, then (at departure preparation)
 * becomes the `onward` service and leaves. Model and formation never change; `destination` of the schedule is the onward one.
 */
export interface EcsSchedule {
  readonly siding: string;
  /** Planned stabling time: from fully stabled until the train begins preparing to leave. */
  readonly stablingS: number;
  readonly onward: { readonly headcode: string; readonly trainClass: 1 | 2 | 5; readonly destination: string; readonly exitLine: LineName };
  /** Movements to set, in order, for the approach and for the departure. */
  readonly approach: readonly string[];
  readonly departure: readonly string[];
  /** Reversal bays used, in order, on the approach and on the departure. */
  readonly approachBays: readonly string[];
  readonly departureBays: readonly string[];
  /**
   * Northbridge: set when this cycle is a TERMINATING service rather than a siding cycle. `siding` then holds the terminus
   * platform id, `stablingS` the dwell at it, and `approach` / `departure` the movements to set on the way in and out.
   */
  readonly terminal?: {
    readonly dwellS: number;
    readonly inboundCall: { readonly platform: string; readonly dwellS: number } | null;
    readonly outboundCall: { readonly platform: string; readonly dwellS: number } | null;
  };
}

/** One scheduled train. */
export interface ServiceSchedule {
  /** Same as the headcode, unique within a shift. */
  readonly id: string;
  readonly headcode: string;
  readonly trainClass: 1 | 2 | 5;
  /** Physical train model (e.g. '170') and its formation (e.g. '2-car'). Separate from the operating class. */
  readonly model: string;
  readonly formation: string;
  readonly origin: string;
  readonly destination: string;
  /** Line the train enters on / leaves on (UP, DOWN or BRANCH). */
  readonly entryLine: LineName;
  readonly exitLine: LineName;
  /** Journey chosen from the logical network (planner path ID) and what it implies. */
  readonly planId: string;
  readonly routeLabel: string;
  /** Sections of the journey, in order. */
  readonly sections: readonly string[];
  /** Movements the signaller must set, in order (the manual ones). */
  readonly manual: readonly string[];
  readonly stops: boolean;
  readonly platform: string | null;
  /** Shortest dwell the train may have (never shortened, even when late). */
  readonly minDwellS: number;
  /** Dwell the timetable allows: departure = arrival + this. */
  readonly scheduledDwellS: number;
  readonly entryS: number;
  readonly arrivalS: number | null;
  readonly departureS: number | null;
  /** Scheduled pass-through time for a non-stopping train (null if its route avoids the station area). */
  readonly passS: number | null;
  readonly exitS: number;
  /** Phase 9: set for an ECS siding cycle. For one, `arrivalS` is the time the train is fully stabled and `departureS` the time it leaves the siding. */
  readonly ecs?: EcsSchedule;
}

/** Every headcode a service uses: the one it enters with and, for an ECS cycle, the onward one. */
export const headcodesOf = (s: Pick<ServiceSchedule, 'headcode' | 'ecs'>): string[] => (s.ecs ? [s.headcode, s.ecs.onward.headcode] : [s.headcode]);

/** The useful ways two services in the area together can interact (Phase 10 diagnostics). */
export type InteractionKind = 'opposing' | 'express-local' | 'branch-main' | 'ecs-passenger';

/** What a timetable asks of the signaller, measured from the scheduled windows. Testing information only. */
export interface TrafficStats {
  readonly services: number;
  /** The most services in the controlled area at one moment. */
  readonly maxConcurrent: number;
  /** Pairs of services whose time in the area overlaps. */
  readonly overlappingPairs: number;
  /** ...of those, pairs that never share a section or point. */
  readonly independentSimultaneous: number;
  /** ...and pairs that share a point or crossing and are kept apart by time alone. */
  readonly junctionInteractions: number;
  /** Overlapping pairs whose use of something shared comes within CLOSE_SEQUENCE_S of each other: routes must be prepared in advance. */
  readonly closeSequences: number;
  /** Overlapping pairs by kind of interaction (a pair may be of more than one kind). */
  readonly byKind: Readonly<Record<InteractionKind, number>>;
}

/** How a shift was generated: what was asked for, what was produced and what had to give. Testing information only. */
export interface GenerationReport {
  readonly difficulty: string;
  readonly targetRange: readonly [number, number];
  /** The number of services the generator aimed for (inside the range). */
  readonly requested: number;
  readonly generated: number;
  /** Why fewer services than requested were produced; empty when the target was met. */
  readonly reductionReasons: readonly string[];
  /** Services moved, re-chosen or dropped, and attempts rejected, with the reason. */
  readonly revisions: readonly string[];
  readonly stats: TrafficStats;
}

export interface Timetable {
  readonly seed: number;
  /** Phase 10: the difficulty the shift was generated for (absent on a stored older shift). */
  readonly difficulty?: string;
  readonly report?: GenerationReport;
  /** Seconds after midnight at shift time 0. */
  readonly startClockS: number;
  readonly services: readonly ServiceSchedule[];
  /** Scheduled end of the last service. The shift does NOT end here: it ends when everything has completed. */
  readonly endS: number;
  /** True when random generation failed and the known-safe fallback was used. */
  readonly usedFallback: boolean;
  readonly attempts: number;
  /** Issues found in rejected attempts, for the record. */
  readonly rejected: readonly string[];
}

/** The rolling stock a service is run with. */
export const stockOf = (s: Pick<ServiceSchedule, 'model' | 'formation'>): StockRef => ({ model: s.model, formation: s.formation });

/** What actually happened to a service (all null until it happens). */
export interface ServiceActual {
  readonly trainId: string | null;
  /** When the train was put at its boundary (eligible). */
  readonly createdS: number | null;
  readonly entryS: number | null;
  readonly arrivalS: number | null;
  /** Dwell finished and, for a timetabled stop, scheduled departure reached: the train could go if the signals allow. */
  readonly readyS: number | null;
  readonly departureS: number | null;
  readonly passS: number | null;
  readonly exitS: number | null;
  readonly cancelledS: number | null;
  /** The train could not be created at all (never expected: the timetable is validated). Counted as failed, not completed. */
  readonly failedReason: string | null;
  /** The platform the train actually stopped at (the scheduled one is `ServiceSchedule.platform`). Absent in older saved shifts. */
  readonly actualPlatform?: string | null;
}

export const emptyActual = (): ServiceActual => ({ trainId: null, createdS: null, entryS: null, arrivalS: null, readyS: null, departureS: null, passS: null, exitS: null, cancelledS: null, failedReason: null, actualPlatform: null });

/** A service has reached an end state: nothing more will happen to it. */
export const isTerminal = (a: ServiceActual): boolean => a.exitS !== null || a.cancelledS !== null || a.failedReason !== null;

/** Delay = actual − scheduled, in seconds. Positive: late. Negative: early. null: not applicable or not yet happened. */
export interface Delays {
  readonly entry: number | null;
  readonly arrival: number | null;
  readonly departure: number | null;
  readonly exit: number | null;
}

export const delayOf = (actual: number | null, scheduled: number | null): number | null => (actual === null || scheduled === null ? null : actual - scheduled);

export function delaysOf(s: ServiceSchedule, a: ServiceActual): Delays {
  return { entry: delayOf(a.entryS, s.entryS), arrival: delayOf(a.arrivalS, s.arrivalS), departure: delayOf(a.departureS, s.departureS), exit: delayOf(a.exitS, s.exitS) };
}

/** A service is "on time" when it is less than this many seconds late (and not more than this early). */
export const ON_TIME_S = 60;

/** Time of day text, e.g. 08:05 or 08:05:30. */
export function clockText(startClockS: number, shiftS: number, seconds = false): string {
  const t = Math.max(0, Math.floor(startClockS + shiftS));
  const h = Math.floor(t / 3600) % 24;
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return seconds ? `${p(h)}:${p(m)}:${p(s)}` : `${p(h)}:${p(m)}`;
}

/** Delay text such as +1:20, −0:30 or on time. */
export function delayText(d: number | null): string {
  if (d === null) return '—';
  const a = Math.abs(Math.round(d));
  const mm = Math.floor(a / 60);
  const ss = String(a % 60).padStart(2, '0');
  if (a === 0) return '0:00';
  return `${d < 0 ? '−' : '+'}${mm}:${ss}`;
}
