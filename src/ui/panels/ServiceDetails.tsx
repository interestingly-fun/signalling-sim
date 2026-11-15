import { CLASS_PROFILES, delayText, ON_TIME_S, stockLabel, type ServiceSchedule } from '../../engine';
import { placeName, type ServiceRow, type ShiftController, type TimetableEntry } from '../sim/shift';
import type { Simulation } from '../sim/simulation';
import { useSlowFrame } from '../sim/useSlowFrame';
import { hm, lateClass } from './timeFormat';

/** A service's scheduled and actual times, one line each, with the delay. Used live and for finished shifts. */
export function JourneyDetail({ shift, row, testPrefix = 'sv', entry }: { shift: ShiftController; row: ServiceRow; testPrefix?: string; entry?: TimetableEntry }) {
  const s: ServiceSchedule = row.service;
  const leg = entry?.leg ?? 'whole';
  const siding = s.ecs ? shift.sidingName(s.ecs.siding) : '';
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
        <dt>Operating class</dt>
        <dd>
          {entry?.trainClass ?? s.trainClass} · {CLASS_PROFILES[entry?.trainClass ?? s.trainClass].name}
        </dd>
        <dt>Train</dt>
        <dd data-testid={`${testPrefix}-stock`}>{stockLabel({ model: s.model, formation: s.formation })}</dd>
        <dt>From → To</dt>
        <dd data-testid={`${testPrefix}-journey`}>
          {leg === 'incoming' ? `${placeName(s.origin)} (${s.entryLine}) → ${siding}` : leg === 'outgoing' ? `${siding} → ${placeName(s.destination)} (${s.ecs?.onward.exitLine ?? s.exitLine})` : `${placeName(s.origin)} (${s.entryLine}) → ${placeName(s.destination)} (${s.exitLine})`}
        </dd>
        <dt>Route</dt>
        <dd data-testid={`${testPrefix}-route`}>{s.routeLabel}</dd>
        {leg !== 'whole' ? (
          <>
            <dt>Entry</dt>
            <dd data-testid={`${testPrefix}-description`}>
              {leg === 'incoming'
                ? `Incoming ECS movement into ${siding}; the same train leaves as ${s.ecs?.onward.headcode}.`
                : `${entry?.headcode} (Outgoing train for ${entry?.forHeadcode}): the same physical train, leaving ${siding}.`}
            </dd>
          </>
        ) : null}
        <dt>{leg === 'whole' ? 'Platform' : 'Siding'}</dt>
        <dd data-testid={`${testPrefix}-platform`}>{leg !== 'whole' ? siding : s.platform ? `${s.platform}, dwell ${s.minDwellS}–${s.scheduledDwellS} s` : 'none (runs through)'}
          {s.platform && a.actualPlatform && a.actualPlatform !== s.platform ? <span className="caution" data-testid={`${testPrefix}-actual-platform`}> · used {a.actualPlatform}</span> : null}</dd>
        <dt>Signaller sets</dt>
        <dd data-testid={`${testPrefix}-sets`}>{s.manual.map((m) => shift.routeText(m)).join(', ') || '—'}</dd>
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
          {leg !== 'outgoing' ? line('Entry', s.entryS, a.entryS, row.delays.entry, 'entry') : null}
          {leg !== 'outgoing' ? line(leg === 'incoming' ? 'Fully stabled' : 'Station arrival', s.arrivalS, a.arrivalS, row.delays.arrival, 'arrival') : null}
          {leg !== 'incoming' ? line(leg === 'outgoing' ? 'Leaves siding' : 'Station departure', s.departureS, a.departureS, row.delays.departure, 'departure') : null}
          {leg === 'whole' ? line('Passes station', s.passS, a.passS, a.passS !== null && s.passS !== null ? a.passS - s.passS : null, 'pass') : null}
          {leg !== 'incoming' ? line('Exit', s.exitS, a.exitS, row.delays.exit, 'exit') : null}
        </tbody>
      </table>
    </>
  );
}

/** Inspector section for the selected timetable service. */
export function ServiceDetails({ sim, shift }: { sim: Simulation; shift: ShiftController }) {
  useSlowFrame(sim, 250);
  const id = shift.selectedServiceId;
  const entry = id ? shift.entries().find((e) => e.entryId === id) : undefined;
  if (!entry) return null;
  const row = entry.row;
  return (
    <section className="service-details" aria-label="Selected service" data-testid="service-details">
      <h3>
        Service <span data-testid="sv-headcode">{entry.headcode}</span>{entry.leg === 'outgoing' ? <span className="muted"> (Outgoing train for {entry.forHeadcode})</span> : null} · <span data-testid="sv-status">{entry.status}</span>
        <button type="button" className="mini close" onClick={() => shift.select(null)} aria-label="Deselect service">
          ×
        </button>
      </h3>
      <JourneyDetail shift={shift} row={row} entry={entry} />
      {row.train ? null : entry.status === 'Completed' || entry.status === 'Cancelled' || entry.status === 'Failed' ? null : <p className="note">Not in the area yet: scheduled information only.</p>}
    </section>
  );
}
