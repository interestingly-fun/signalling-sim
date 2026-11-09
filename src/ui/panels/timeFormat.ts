import type { ShiftController } from '../sim/shift';

export const statusClass = (s: string): string => s.toLowerCase().replace(/[^a-z]+/g, '-');

/** m:ss with a real minus sign; "—" when there is no value. */
export const mmss = (s: number | null): string => {
  if (s === null) return '—';
  const a = Math.round(Math.abs(s));
  return `${s < 0 ? '−' : ''}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
};

/** Time of day for a shift time, in the shift's own clock; "—" when there is none. */
export const hm = (shift: ShiftController, t: number | null, seconds = false): string => (t === null ? '—' : shift.clock(t, seconds));

/** Colour class for an actual time: late (a minute or more) or fine. */
export const lateClass = (delayS: number | null, limitS: number): string => (delayS === null ? '' : delayS >= limitS ? 'late' : 'ontime');
