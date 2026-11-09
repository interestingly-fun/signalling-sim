import { CLASS_PROFILES, delayText, ON_TIME_S, type ServiceSchedule } from '../../engine';
import { placeName, type ServiceRow, type ShiftController } from '../sim/shift';
import type { Simulation } from '../sim/simulation';
import { useSlowFrame } from '../sim/useSlowFrame';
import { hm, lateClass } from './timeFormat';

/** A service's scheduled and actual times, one line each, with the delay. Used live and for finished shifts. */
export function JourneyDetail({ shift, row, testPrefix = 'sv' }: { shift: ShiftController; row: ServiceRow; testPrefix?: string }) {
  const s: ServiceSchedule = row.service;
  const a = row.actual;
  const line = (label: string, sched: number | null, act: number | null, d: number | null, id: string) =>
    sched === null && act === null ? null : (
      <tr data-testid={`${testPrefix}-${id}`}>
        <td>{label}</td>
        <td className="mono sched">{hm(shift, sched, true)}</td>
        <td className={`mono actual ${lateClass(d, ON_TIME_S)}`}>{hm(shift, act, true)}</td>
        <td className={`mono ${lateClass(d, ON_TIME_S)}`}>{d === null ? '—' : delayText(d)}</td>
      </tr>
    );
  return (
    <>
      <dl className="train-readout">
        <dt>Class</dt>
        <dd>
          {s.trainClass} · {CLASS_PROFILES[s.trainClass].name}
        </dd>
        <dt>From → To</dt>
        <dd data-testid={`${testPrefix}-journey`}>
          {placeName(s.origin)} ({s.entryLine}) → {placeName(s.destination)} ({s.exitLine})
        </dd>
        <dt>Route</dt>
        <dd data-testid={`${testPrefix}-route`}>{s.routeLabel}</dd>
        <dt>Platform</dt>
        <dd data-testid={`${testPrefix}-platform`}>{s.platform ? `${s.platform}, dwell ${s.minDwellS}–${s.scheduledDwellS} s` : 'none (runs through)'}</dd>
        <dt>Signaller sets</dt>
        <dd data-testid={`${testPrefix}-sets`}>{s.manual.join(', ') || '—'}</dd>
      </dl>
      <table className="sv-times" aria-label="Scheduled and actual times">
        <thead>
          <tr>
            <th />
            <th>Scheduled</th>
            <th>Actual</th>
            <th>Delay</th>
          </tr>
        </thead>
        <tbody>
          {line('Entry', s.entryS, a.entryS, row.delays.entry, 'entry')}
          {line('Station arrival', s.arrivalS, a.arrivalS, row.delays.arrival, 'arrival')}
          {line('Station departure', s.departureS, a.departureS, row.delays.departure, 'departure')}
          {line('Passes station', s.passS, a.passS, a.passS !== null && s.passS !== null ? a.passS - s.passS : null, 'pass')}
          {line('Exit', s.exitS, a.exitS, row.delays.exit, 'exit')}
        </tbody>
      </table>
    </>
  );
}

/** Inspector section for the selected timetable service. */
export function ServiceDetails({ sim, shift }: { sim: Simulation; shift: ShiftController }) {
  useSlowFrame(sim, 250);
  const id = shift.selectedServiceId;
  const row = id ? shift.rows().find((r) => r.service.id === id) : undefined;
  if (!row) return null;
  return (
    <section className="service-details" aria-label="Selected service" data-testid="service-details">
      <h3>
        Service <span data-testid="sv-headcode">{row.service.headcode}</span> · <span data-testid="sv-status">{row.status}</span>
        <button type="button" className="mini close" onClick={() => shift.select(null)} aria-label="Deselect service">
          ×
        </button>
      </h3>
      <JourneyDetail shift={shift} row={row} />
      {row.train ? null : row.status === 'Completed' || row.status === 'Cancelled' || row.status === 'Failed' ? null : <p className="note">Not in the area yet: scheduled information only.</p>}
    </section>
  );
}
