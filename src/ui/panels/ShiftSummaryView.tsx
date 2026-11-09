import { useState } from 'react';
import { delayText, type ShiftSummary } from '../../engine';
import { placeName, type ServiceRow, type Shift, type ShiftController } from '../sim/shift';
import { JourneyDetail } from './ServiceDetails';
import { LogLines } from './LogPanel';
import { hm, mmss, statusClass } from './timeFormat';

const avg = (s: number | null): string => (s === null ? 'n/a' : delayText(s));

interface Props {
  readonly shift: ShiftController;
  readonly shiftData: Shift;
  readonly summary: ShiftSummary;
  readonly onReturn: () => void;
  readonly onAnother: () => void;
}

type Tab = 'summary' | 'services' | 'events';

/** End-of-shift report (also used to review earlier shifts): summary, per-service history, and the shift's events. */
export function SummaryView({ shift, shiftData, summary: m, onReturn, onAnother }: Props) {
  const [tab, setTab] = useState<Tab>('summary');
  const title = shiftData.status === 'abandoned' ? 'abandoned' : 'complete';
  return (
    <div className="tt-summary" role="region" aria-label="Shift summary" data-testid="shift-summary">
      <h3>
        Shift {m.shiftId} {title} {shiftData.endedS !== null ? `at ${shift.clock(shiftData.endedS, true)}` : ''}
        <span className="sum-headline">
          {m.completed}/{m.scheduled} completed · {m.onTime} on time · {m.delayed} delayed
        </span>
      </h3>
      <div className="tabs" role="tablist">
        {(['summary', 'services', 'events'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)} data-testid={`sum-tab-${t}`}>
            {t === 'summary' ? 'Summary' : t === 'services' ? 'Service history' : 'Events'}
          </button>
        ))}
      </div>
      {tab === 'summary' ? (
        <div className="summary-cols">
          <dl className="summary-grid">
            <dt>Scheduled trains</dt>
            <dd data-testid="sum-scheduled">{m.scheduled}</dd>
            <dt>Completed</dt>
            <dd data-testid="sum-completed">{m.completed}</dd>
            <dt>Cancelled</dt>
            <dd data-testid="sum-cancelled">{m.cancelled}</dd>
            <dt>Failed</dt>
            <dd data-testid="sum-failed">{m.failed}</dd>
            <dt>Class 1 / 2 / 5</dt>
            <dd data-testid="sum-classes">
              {m.class1} / {m.class2} / {m.class5}
            </dd>
            <dt>Stopped at the station</dt>
            <dd data-testid="sum-stopped">{m.stoppedAtStation}</dd>
          </dl>
          <dl className="summary-grid">
            <dt>On time (&lt; 1 min late)</dt>
            <dd data-testid="sum-ontime">{m.onTime}</dd>
            <dt>Delayed (1 min or more)</dt>
            <dd data-testid="sum-delayed">{m.delayed}</dd>
            <dt>Most delayed train</dt>
            <dd data-testid="sum-most">{m.mostDelayed ? `${m.mostDelayed.headcode} (${delayText(m.mostDelayed.delayS)})` : 'none'}</dd>
            <dt>Total delay</dt>
            <dd data-testid="sum-total">{mmss(m.totalDelayS)}</dd>
          </dl>
          <dl className="summary-grid">
            <dt>Average entry delay</dt>
            <dd data-testid="sum-avg-entry">{avg(m.avgEntryDelayS)}</dd>
            <dt>Average arrival delay</dt>
            <dd data-testid="sum-avg-arrival">{avg(m.avgArrivalDelayS)}</dd>
            <dt>Average departure delay</dt>
            <dd data-testid="sum-avg-departure">{avg(m.avgDepartureDelayS)}</dd>
            <dt>Average exit delay</dt>
            <dd data-testid="sum-avg-exit">{avg(m.avgExitDelayS)}</dd>
          </dl>
        </div>
      ) : null}
      {tab === 'services' ? <History shift={shift} shiftData={shiftData} /> : null}
      {tab === 'events' ? (
        <div data-testid="shift-events">
          <LogLines entries={shiftData.events} empty="No events were recorded for this shift." />
        </div>
      ) : null}
      <div className="tt-controls">
        <button type="button" onClick={onReturn} data-testid="summary-return">
          Return to timetable
        </button>
        <button type="button" className="primary" onClick={onAnother} data-testid="summary-another">
          Start another shift
        </button>
        <button type="button" onClick={() => setTab(tab === 'services' ? 'summary' : 'services')} data-testid="summary-history">
          {tab === 'services' ? 'Hide service history' : 'Review service history'}
        </button>
      </div>
    </div>
  );
}

function History({ shift, shiftData }: { shift: ShiftController; shiftData: Shift }) {
  const rows = shift.rows(shiftData);
  const [openId, setOpenId] = useState<string | null>(null);
  const open: ServiceRow | undefined = rows.find((r) => r.service.id === openId);
  const cell = (sched: number | null, act: number | null, d: number | null) => (sched === null ? '—' : `${hm(shift, sched, true)} → ${act === null ? '—' : hm(shift, act, true)} (${delayText(d)})`);
  return (
    <>
      <div className="tt-scroll">
        <table className="tt-table" aria-label="Service history" data-testid="service-history">
          <thead>
            <tr>
              <th>Headcode</th>
              <th>Journey</th>
              <th>Outcome</th>
              <th>Entry</th>
              <th>Station arrival</th>
              <th>Station departure</th>
              <th>Exit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.service.id} className={`tt-row${openId === r.service.id ? ' selected' : ''}`} onClick={() => setOpenId(openId === r.service.id ? null : r.service.id)} data-testid={`hist-row-${r.service.headcode}`}>
                <td className="mono">
                  {r.service.headcode} <span className="muted">Cl{r.service.trainClass}</span>
                </td>
                <td>
                  {placeName(r.service.origin)} → {placeName(r.service.destination)}
                </td>
                <td>
                  <span className={`st-dot st-${statusClass(r.status)}`} aria-hidden="true" /> {r.status}
                </td>
                <td className="mono">{cell(r.service.entryS, r.actual.entryS, r.delays.entry)}</td>
                <td className="mono">{cell(r.service.arrivalS, r.actual.arrivalS, r.delays.arrival)}</td>
                <td className="mono">{cell(r.service.departureS, r.actual.departureS, r.delays.departure)}</td>
                <td className="mono">{cell(r.service.exitS, r.actual.exitS, r.delays.exit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">Click a service to inspect its journey.</p>
      {open ? (
        <div className="journey" data-testid="journey">
          <h4>Journey of {open.service.headcode}</h4>
          <JourneyDetail shift={shift} row={open} testPrefix="jr" />
        </div>
      ) : null}
    </>
  );
}
