/**
 * The operational event log (Phase 6).
 *
 * Plain TypeScript, no React. Every entry carries SIMULATION time (the sim clock, shown as time of
 * day from 08:00), a category and a level. The log keeps everything it is given (bounded); what the
 * panel shows is a filtered view, and "Clear" only moves the view's start, so the underlying record
 * (and the per-shift records) are never lost by clearing.
 *
 * Sources are wired by `attachLogging`: train events from the engine, signalling changes from a
 * state diff on every state change, and the shift controller's own timetable events.
 */

import { SHIFT_START_CLOCK_S, clockText, diffSignalling, type SignallingState, type TrainEvent } from '../../engine';
import type { Simulation } from './simulation';

export type LogCategory = 'train' | 'route' | 'signal' | 'point' | 'timetable' | 'shift' | 'system';
export type LogLevel = 'info' | 'ok' | 'warn' | 'error';

export const LOG_CATEGORIES: readonly { readonly id: LogCategory; readonly label: string }[] = [
  { id: 'train', label: 'Trains' },
  { id: 'route', label: 'Routes' },
  { id: 'signal', label: 'Signals' },
  { id: 'point', label: 'Points' },
  { id: 'timetable', label: 'Timetable' },
  { id: 'shift', label: 'Shift' },
  { id: 'system', label: 'Other' },
];

export interface LogEntry {
  readonly seq: number;
  /** Simulation seconds since the clock was zeroed. */
  readonly simS: number;
  /** Time of day, hh:mm:ss. */
  readonly clock: string;
  readonly category: LogCategory;
  readonly level: LogLevel;
  readonly text: string;
  /** The shift this happened in (null outside a shift). */
  readonly shiftId: number | null;
}

/** The underlying record is bounded so a very long session cannot grow without limit. */
export const MAX_RECORD = 3000;

export class EventLog {
  private all: LogEntry[] = [];
  private seq = 0;
  private visibleFromSeq = 0;
  private listeners = new Set<() => void>();
  private version = 0;
  private mutedDepth = 0;
  /** Set by the shift controller while a shift is running. */
  shiftId: number | null = null;

  constructor(private readonly now: () => number = () => 0) {}

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  readonly getVersion = (): number => this.version;
  private touch(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  /** Runs `fn` without logging (used when the whole state is replaced, e.g. at shift start). */
  silent<T>(fn: () => T): T {
    this.mutedDepth++;
    try {
      return fn();
    } finally {
      this.mutedDepth--;
    }
  }
  get isMuted(): boolean {
    return this.mutedDepth > 0;
  }

  add(category: LogCategory, level: LogLevel, text: string): void {
    if (this.mutedDepth > 0) return;
    // the same line again within the last few entries is noise
    for (let i = this.all.length - 1; i >= Math.max(0, this.all.length - 3); i--) {
      const e = this.all[i] as LogEntry;
      if (e.text === text && e.category === category && this.now() - e.simS < 2) return;
    }
    const simS = this.now();
    this.all.push({ seq: ++this.seq, simS, clock: clockText(SHIFT_START_CLOCK_S, simS, true), category, level, text, shiftId: this.shiftId });
    if (this.all.length > MAX_RECORD) this.all.splice(0, this.all.length - MAX_RECORD);
    this.touch();
  }

  /** Everything recorded, oldest first. Unaffected by Clear. */
  get record(): readonly LogEntry[] {
    return this.all;
  }

  /** What the panel shows: entries since the last Clear, in the chosen categories, newest first. */
  visible(categories: ReadonlySet<LogCategory>, limit = 200): LogEntry[] {
    const out: LogEntry[] = [];
    for (let i = this.all.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.all[i] as LogEntry;
      if (e.seq <= this.visibleFromSeq) break;
      if (categories.has(e.category)) out.push(e);
    }
    return out;
  }

  /** Hides what is shown now. The record and shift histories are untouched. */
  clearVisible(): void {
    this.visibleFromSeq = this.seq;
    this.touch();
  }

  get hiddenCount(): number {
    return this.all.filter((e) => e.seq <= this.visibleFromSeq).length;
  }

  /** The events of one shift, for its record. */
  forShift(id: number): LogEntry[] {
    return this.all.filter((e) => e.shiftId === id);
  }
}

/** Train-engine event kinds a running shift reports itself (with timetable context), so they are not logged twice. */
const SHIFT_REPORTED = new Set<TrainEvent['kind']>(['admitted', 'arrived', 'ready', 'departed', 'exited', 'finished']);

/**
 * Connects the log to a simulation: engine events and signalling-state changes. Returns a detach function.
 * Wiring happens once; calling the returned function removes both listeners (no accumulation on re-mount).
 */
export function attachLogging(sim: Simulation, log: EventLog, shiftRunning: () => boolean): () => void {
  let last: SignallingState = sim.getSig();
  const offState = sim.subscribeSig(() => {
    const next = sim.getSig();
    const prev = last;
    last = next;
    if (log.isMuted) return;
    for (const c of diffSignalling(sim.ctx, prev, next)) log.add(c.category, c.level, c.text);
  });
  const offEvents = sim.onEvents((events) => {
    for (const e of events) {
      if (e.kind === 'entered' || e.kind === 'cleared') continue; // far too frequent; the diagram shows them
      if (shiftRunning() && (SHIFT_REPORTED.has(e.kind) || e.kind === 'moving')) continue;
      if (e.kind === 'released') {
        // Automatic movements are released after every train: only routes the signaller set are worth a line.
        const route = sim.ctx.route(e.route);
        if (route && sim.ctx.net.signals.get(route.from)?.type === 'manual') log.add('route', 'info', e.text);
      }
      else log.add('train', e.kind === 'protection-stop' ? 'error' : e.kind === 'stopped' || e.kind === 'overspeed' ? 'warn' : 'info', e.text);
    }
  });
  return () => {
    offState();
    offEvents();
  };
}
