import { useState, useSyncExternalStore } from 'react';
import { delayText, ON_TIME_S, stockLabel } from '../../engine';
import { SCENARIOS } from '../sim/scenarios';
import { placeName, type ServiceRow, type Shift, type ShiftController } from '../sim/shift';
import type { Simulation } from '../sim/simulation';
import { useSlowFrame } from '../sim/useSlowFrame';
import { SummaryView } from './ShiftSummaryView';
import { SPEEDS } from './TrainPanel';
import { hm, lateClass, statusClass } from './timeFormat';

interface Props {
  readonly sim: Simulation;
  readonly shift: ShiftController;
}

export { ServiceDetails } from './ServiceDetails';

/** Shift clock chip for the top bar. */
export function ShiftClock({ sim, shift }: Props) {
  useSlowFrame(sim, 250);
  useSyncExternalStore(shift.subscribe, shift.getVersion);
  const sh = shift.current;
  if (!sh || sh.status === 'not started') return <span className="chip idle" data-testid="shift-clock">Shift not started</span>;
  const t = sh.status === 'running' ? sim.clockS : (sh.endedS ?? sim.clockS);
  return (
    <span className={`chip ${sh.status === 'running' ? (sim.isPaused ? 'warn' : 'ok') : 'idle'}`} data-testid="shift-clock" title={`Shift ${sh.id} ${sh.status}`}>
      {shift.clock(t, true)} · Shift {sh.id} {sh.status === 'running' ? (sim.isPaused ? 'paused' : 'running') : sh.status}
    </span>
  );
}

/** Shift controls, the live timetable, and the shift-end summary. */
export function TimetablePanel({ sim, shift }: Props) {
  useSlowFrame(sim, 250);
  useSyncExternalStore(shift.subscribe, shift.getVersion);
  const [seed, setSeed] = useState('');
  const [scenario, setScenario] = useState('random');
  const [confirm, setConfirm] = useState(false);
  const [hideDone, setHideDone] = useState(false);
  const [dismissed, setDismissed] = useState<number | null>(null); // shift whose summary was closed
  const [viewing, setViewing] = useState<Shift | null>(null); // an earlier shift being reviewed
  const [forgetAsk, setForgetAsk] = useState(false);

  const cur = shift.current;
  const running = shift.running;
  const justEnded = cur && cur.status === 'completed' && dismissed !== cur.id ? cur : null;
  const summaryShift = viewing ?? justEnded;
  const tt = shift.timetable;
  const rows = shift.rows();
  const nextId = running ? rows.find((r) => r.actual.trainId === null && r.actual.cancelledS === null && r.actual.failedReason === null && r.actual.exitS === null)?.service.id : undefined;
  const shown = hideDone ? rows.filter((r) => !['Completed', 'Cancelled', 'Failed'].includes(r.status)) : rows;
  const doneCount = rows.filter((r) => r.status === 'Completed').length;
  const lateCount = rows.filter((r) => r.delayS !== null && r.delayS >= ON_TIME_S && r.actual.exitS === null && r.actual.cancelledS === null).length;
  const sc = SCENARIOS.find((s) => s.id === scenario);

  const onGenerate = () => {
    const typed = seed.trim() === '' ? undefined : Number(seed);
    const useSeed = typed !== undefined && Number.isFinite(typed) ? typed : (sc?.seed ?? undefined);
    shift.generate(useSeed);
    setViewing(null);
  };

  return (
    <section className="panel timetable-panel" aria-label="Shift and timetable" data-testid="timetable-panel">
      <h2>
        Shift timetable
        <span className="tt-title-info" data-testid="shift-info">
          {cur?.status === 'running' ? ` · Shift ${cur.id} running` : cur ? ` · Shift ${cur.id} ${cur.status}` : tt ? ' · not started' : ''}
          {tt ? ` · ${tt.services.length} services · ${shift.clock(0)}–${shift.clock(tt.endS)}` : ''}
          {running ? ` · ${doneCount} done · ${lateCount} delayed` : ''}
          {tt?.usedFallback ? ' · fallback timetable' : ''}
        </span>
      </h2>
      <div className="panel-body tt-body">
        <div className="tt-controls">
          {!running ? (
            <>
              <label className="tt-seed">
                Scenario{' '}
                <select aria-label="Scenario" value={scenario} onChange={(e) => setScenario(e.target.value)} title={sc?.description} data-testid="scenario">
                  {SCENARIOS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="tt-seed">
                Seed{' '}
                <input aria-label="Timetable seed" className="seed-input" value={seed} placeholder={sc?.seed !== null && sc ? String(sc.seed) : 'random'} inputMode="numeric" onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, '').slice(0, 9))} />
              </label>
              <button type="button" onClick={onGenerate} data-testid="generate-timetable">
                Generate timetable
              </button>
              <button
                type="button"
                className="primary"
                data-testid="start-shift"
                onClick={() => {
                  setViewing(null);
                  setDismissed(null);
                  shift.start();
                }}
                disabled={!shift.draft}
                title={shift.draft ? 'Start the shift on the timetable shown' : 'Generate a timetable first'}
              >
                Start shift
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => (sim.mode === 'paused' ? sim.resume() : sim.pause())} data-testid="shift-pause">
                {sim.mode === 'paused' ? 'Resume' : 'Pause'}
              </button>
              <label className="tt-seed">
                Speed{' '}
                <select aria-label="Shift speed" value={sim.speedFactor} onChange={(e) => sim.setSpeed(Number(e.target.value))} data-testid="shift-speed">
                  {SPEEDS.map((f) => (
                    <option key={f} value={f}>
                      {f}×
                    </option>
                  ))}
                </select>
              </label>
              {!confirm ? (
                <button type="button" onClick={() => setConfirm(true)} data-testid="abandon-shift">
                  Abandon shift
                </button>
              ) : (
                <span className="confirm" role="alertdialog" aria-label="Confirm abandon shift">
                  Abandon this shift? All trains are removed.{' '}
                  <button
                    type="button"
                    className="danger"
                    data-testid="confirm-abandon"
                    onClick={() => {
                      shift.abandon();
                      setConfirm(false);
                    }}
                  >
                    Yes, abandon
                  </button>{' '}
                  <button type="button" onClick={() => setConfirm(false)} data-testid="keep-shift">
                    Keep playing
                  </button>
                </span>
              )}
              <label className="tt-seed">
                <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} data-testid="hide-done" /> Hide finished
              </label>
            </>
          )}
        </div>
        {shift.history.length > 0 && !running ? (
          <div className="tt-history" data-testid="shift-history">
            <span className="muted">Recent shifts:</span>
            {[...shift.history].reverse().map((h) => (
              <button key={h.id} type="button" className={`link${viewing?.id === h.id ? ' on' : ''}`} onClick={() => setViewing(viewing?.id === h.id ? null : h)} data-testid={`history-${h.id}`} title={`Seed ${h.timetable.seed}`}>
                Shift {h.id} · {h.status} · {h.summary?.completed ?? 0}/{h.summary?.scheduled ?? 0} done
              </button>
            ))}
            {!forgetAsk ? (
              <button type="button" className="mini" onClick={() => setForgetAsk(true)} data-testid="forget-history">
                Forget saved shifts
              </button>
            ) : (
              <span className="confirm">
                Delete all saved shift records?{' '}
                <button
                  type="button"
                  className="danger mini"
                  onClick={() => {
                    shift.clearHistory();
                    setViewing(null);
                    setForgetAsk(false);
                  }}
                  data-testid="confirm-forget"
                >
                  Delete
                </button>{' '}
                <button type="button" className="mini" onClick={() => setForgetAsk(false)}>
                  Keep
                </button>
              </span>
            )}
          </div>
        ) : null}

        {summaryShift && summaryShift.summary ? (
          <SummaryView
            key={summaryShift.id}
            shift={shift}
            shiftData={summaryShift}
            summary={summaryShift.summary}
            onReturn={() => {
              setViewing(null);
              setDismissed(summaryShift.id);
            }}
            onAnother={() => {
              setViewing(null);
              setDismissed(summaryShift.id);
              shift.generate();
            }}
          />
        ) : null}

        {tt ? (
          <div className="tt-scroll">
            <table className="tt-table" aria-label="Timetable" data-testid="timetable">
              <thead>
                <tr>
                  <th>Entry</th>
                  <th>Headcode</th>
                  <th>Cl</th>
                  <th>Unit</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Platform</th>
                  <th>Arrive</th>
                  <th>Depart</th>
                  <th>Status</th>
                  <th>Delay</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <TimetableRow key={r.service.id} row={r} shift={shift} isNext={r.service.id === nextId} onCancel={() => shift.cancelService(r.service.id)} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No timetable yet.</p>
        )}
        <p className="note tt-note">
          Each time shows <span className="sched">scheduled</span> above the <span className="actual ontime">actual</span> time once it has happened (amber when a minute or more late). The shift ends only when every service has completed or been cancelled and the last train has
          completely left the area.
        </p>
      </div>
    </section>
  );
}

/** Scheduled time with the actual time beneath it once it has happened. */
function TimeCell({ shift, sched, actual, delayS, label }: { shift: ShiftController; sched: number | null; actual: number | null; delayS: number | null; label?: string }) {
  if (sched === null) return <td className="mono tcell">—</td>;
  return (
    <td className="mono tcell">
      <span className="sched">
        {label}
        {hm(shift, sched)}
      </span>
      {actual !== null ? <span className={`actual ${lateClass(delayS, ON_TIME_S)}`}>{hm(shift, actual, true)}</span> : null}
    </td>
  );
}

function TimetableRow({ row, shift, isNext, onCancel }: { row: ServiceRow; shift: ShiftController; isNext: boolean; onCancel: () => void }) {
  const s = row.service;
  const a = row.actual;
  const selected = shift.selectedServiceId === s.id;
  const late = row.delayS !== null && row.delayS >= ON_TIME_S;
  const canCancel = shift.running && a.entryS === null && a.cancelledS === null && a.failedReason === null;
  return (
    <tr
      className={`tt-row st-${statusClass(row.status)}${selected ? ' selected' : ''}${isNext ? ' next' : ''}${late && a.exitS === null ? ' late-row' : ''}`}
      data-testid={`tt-row-${s.headcode}`}
      data-status={row.status}
      onClick={() => shift.select(s.id)}
      aria-selected={selected}
    >
      <TimeCell shift={shift} sched={s.entryS} actual={a.entryS} delayS={row.delays.entry} />
      <td className="mono hc">
        <button type="button" className="link" aria-label={`Select service ${s.headcode}`} onClick={(e) => { e.stopPropagation(); shift.select(s.id); }}>
          {s.headcode}
        </button>
        {isNext ? (
          <span className="badge next-badge" title="The next service due to enter">
            NEXT
          </span>
        ) : null}
      </td>
      <td>{s.trainClass}</td>
      <td className="mono unit" title={stockLabel({ model: s.model, formation: s.formation })}>
        {s.model}
        <span className="muted"> {s.formation.replace('-car', 'c')}</span>
      </td>
      <td>{placeName(s.origin)}</td>
      <td>{placeName(s.destination)}</td>
      <td>{s.platform ? s.platform.replace('PLAT', 'Pl ') : '—'}</td>
      {s.stops ? <TimeCell shift={shift} sched={s.arrivalS} actual={a.arrivalS} delayS={row.delays.arrival} /> : <TimeCell shift={shift} sched={s.passS} actual={a.passS} delayS={a.passS !== null && s.passS !== null ? a.passS - s.passS : null} label="pass " />}
      {s.stops ? <TimeCell shift={shift} sched={s.departureS} actual={a.departureS} delayS={row.delays.departure} /> : <td className="mono tcell">—</td>}
      <td data-testid={`tt-status-${s.headcode}`}>
        <span className={`st-dot st-${statusClass(row.status)}`} aria-hidden="true" /> {row.status}
      </td>
      <td className={`mono delay${late ? ' late' : ''}`} data-testid={`tt-delay-${s.headcode}`}>
        {row.delayS === null ? '—' : delayText(row.delayS)}
      </td>
      <td>
        {canCancel ? (
          <button type="button" className="mini" onClick={(e) => { e.stopPropagation(); onCancel(); }} aria-label={`Cancel ${s.headcode}`}>
            Cancel
          </button>
        ) : null}
      </td>
    </tr>
  );
}
