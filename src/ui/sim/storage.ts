/**
 * Local history of finished shifts (Phase 6), kept in the browser's localStorage.
 *
 * Saved data is never trusted. It is versioned, parsed defensively and validated field by field; a
 * shift that does not fit the current schema is dropped on its own, and anything unreadable (not
 * JSON, wrong version, wrong shape, storage blocked) yields an empty history. Nothing here can stop
 * a fresh shift from being started: every function swallows its own failures.
 */

import { defaultStock, isValidStock } from '../../engine';
import type { ServiceActual, ServiceSchedule, ShiftSummary, Timetable } from '../../engine';
import type { LogEntry } from './eventLog';
import type { Shift } from './shift';

export const STORAGE_KEY = 'ashcombe.shifts';
export const STORAGE_VERSION = 1;
export const MAX_STORED_SHIFTS = 8;
const MAX_STORED_EVENTS = 400;

/** The part of the Storage interface used, so tests can pass a fake. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown): v is number | null => v === null || num(v);
const str = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): v is string | null => v === null || str(v);

function validService(v: unknown): v is ServiceSchedule {
  return (
    isRec(v) &&
    str(v.id) && str(v.headcode) && str(v.model) && str(v.formation) && isValidStock({ model: v.model, formation: v.formation }) && (v.trainClass === 1 || v.trainClass === 2 || v.trainClass === 5) &&
    str(v.origin) && str(v.destination) && str(v.entryLine) && str(v.exitLine) && str(v.planId) && str(v.routeLabel) &&
    Array.isArray(v.sections) && v.sections.every(str) && Array.isArray(v.manual) && v.manual.every(str) &&
    typeof v.stops === 'boolean' && strOrNull(v.platform) && num(v.minDwellS) && num(v.scheduledDwellS) &&
    num(v.entryS) && numOrNull(v.arrivalS) && numOrNull(v.departureS) && numOrNull(v.passS) && num(v.exitS)
  );
}

function validActual(v: unknown): v is ServiceActual {
  return (
    isRec(v) &&
    strOrNull(v.trainId) && numOrNull(v.createdS) && numOrNull(v.entryS) && numOrNull(v.arrivalS) && numOrNull(v.readyS) &&
    numOrNull(v.departureS) && numOrNull(v.passS) && numOrNull(v.exitS) && numOrNull(v.cancelledS) && strOrNull(v.failedReason)
  );
}

const SUMMARY_NUMBERS = ['shiftId', 'scheduled', 'completed', 'cancelled', 'failed', 'class1', 'class2', 'class5', 'stoppedAtStation', 'onTime', 'delayed', 'totalDelayS'] as const;
const SUMMARY_NULLABLE = ['avgEntryDelayS', 'avgArrivalDelayS', 'avgDepartureDelayS', 'avgExitDelayS'] as const;

function validSummary(v: unknown): v is ShiftSummary {
  if (!isRec(v)) return false;
  if (!SUMMARY_NUMBERS.every((k) => num(v[k])) || !SUMMARY_NULLABLE.every((k) => numOrNull(v[k]))) return false;
  const m = v.mostDelayed;
  return m === null || (isRec(m) && str(m.headcode) && num(m.delayS));
}

const LEVELS = ['info', 'ok', 'warn', 'error'];
const CATS = ['train', 'route', 'signal', 'point', 'timetable', 'shift', 'system'];
function validEvent(v: unknown): v is LogEntry {
  return isRec(v) && num(v.seq) && num(v.simS) && str(v.clock) && str(v.text) && str(v.level) && LEVELS.includes(v.level) && str(v.category) && CATS.includes(v.category) && (v.shiftId === null || num(v.shiftId));
}

function validTimetable(v: unknown): v is Timetable {
  return isRec(v) && num(v.seed) && num(v.startClockS) && num(v.endS) && typeof v.usedFallback === 'boolean' && num(v.attempts) && Array.isArray(v.rejected) && Array.isArray(v.services) && v.services.length > 0 && v.services.every(validService);
}

/**
 * Shifts saved before rolling stock existed (Phase 6) have no model or formation on their services. They are
 * kept: each service gets the default stock for its class, and the record shows it as such.
 */
function withStock(timetable: unknown): unknown {
  if (!isRec(timetable) || !Array.isArray(timetable.services)) return timetable;
  const services = timetable.services.map((s: unknown) => {
    if (!isRec(s) || s.model !== undefined || (s.trainClass !== 1 && s.trainClass !== 2 && s.trainClass !== 5)) return s;
    const d = defaultStock(s.trainClass);
    return { ...s, model: d.model, formation: d.formation };
  });
  return { ...timetable, services };
}

/** One stored shift back into a Shift, or null when it does not fit. */
export function parseShift(v: unknown): Shift | null {
  if (!isRec(v) || !num(v.id) || v.id < 1 || (v.status !== 'completed' && v.status !== 'abandoned') || !numOrNull(v.endedS)) return null;
  const timetable = withStock(v.timetable);
  if (!validTimetable(timetable) || !validSummary(v.summary) || !Array.isArray(v.actuals) || !Array.isArray(v.events)) return null;
  const actuals = new Map<string, ServiceActual>();
  for (const pair of v.actuals) {
    if (!Array.isArray(pair) || pair.length !== 2 || !str(pair[0]) || !validActual(pair[1])) return null;
    actuals.set(pair[0], pair[1]);
  }
  if (!timetable.services.every((s) => actuals.has(s.id))) return null;
  const events = v.events.filter(validEvent);
  return { id: v.id, timetable, status: v.status, endedS: v.endedS, actuals, summary: v.summary, events };
}

export function serialiseShifts(shifts: readonly Shift[]): string {
  const recent = shifts.filter((s) => s.status !== 'running' && s.status !== 'not started' && s.summary !== null).slice(-MAX_STORED_SHIFTS);
  return JSON.stringify({
    version: STORAGE_VERSION,
    shifts: recent.map((s) => ({ id: s.id, status: s.status, endedS: s.endedS, timetable: s.timetable, actuals: [...s.actuals.entries()], summary: s.summary, events: s.events.slice(-MAX_STORED_EVENTS) })),
  });
}

/** Parses stored text. Never throws; invalid shifts are skipped, an unusable payload gives []. */
export function parseShifts(text: string | null): Shift[] {
  if (!text) return [];
  try {
    const data: unknown = JSON.parse(text);
    if (!isRec(data) || data.version !== STORAGE_VERSION || !Array.isArray(data.shifts)) return [];
    const out: Shift[] = [];
    for (const raw of data.shifts) {
      const s = parseShift(raw);
      if (s && !out.some((o) => o.id === s.id)) out.push(s);
    }
    return out.slice(-MAX_STORED_SHIFTS);
  } catch {
    return [];
  }
}

export interface ShiftStore {
  load(): Shift[];
  save(history: readonly Shift[]): void;
}

/** A store over localStorage (or a fake). Failures are logged to the console only. */
export function localShiftStore(getStore: () => KeyValueStore | null = () => (typeof localStorage === 'undefined' ? null : localStorage)): ShiftStore {
  return {
    load() {
      try {
        const store = getStore();
        if (!store) return [];
        const text = store.getItem(STORAGE_KEY);
        const shifts = parseShifts(text);
        if (text && shifts.length === 0) {
          console.warn('Ashcombe: saved shift history was unreadable and has been discarded.');
          store.removeItem(STORAGE_KEY);
        }
        return shifts;
      } catch (e) {
        console.warn('Ashcombe: saved shift history could not be read.', e);
        return [];
      }
    },
    save(history) {
      try {
        getStore()?.setItem(STORAGE_KEY, serialiseShifts(history));
      } catch (e) {
        console.warn('Ashcombe: shift history could not be saved.', e);
      }
    },
  };
}
