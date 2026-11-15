import { useState, useSyncExternalStore } from 'react';
import { DIFFICULTIES, DIFFICULTY_IDS, delayText, ON_TIME_S, stockLabel, type DifficultyId } from '../../engine';
import { SCENARIOS } from '../sim/scenarios';
import { placeName, type Shift, type ShiftController, type TimetableEntry } from '../sim/shift';
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
  const [difficulty, setDifficulty] = useState<DifficultyId>(shift.difficulty);
  const [generating, setGenerating] = useState(false);
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
  const rows = shift.entries();
  const nextId = running ? rows.filter((r) => r.leg !== 'outgoing').find((r) => r.row.actual.trainId === null && r.row.actual.cancelledS === null && r.row.actual.failedReason === null && r.row.actual.exitS === null)?.entryId : undefined;
  const shown = hideDone ? rows.filter((r) => !['Completed', 'Cancelled', 'Failed'].includes(r.status)) : rows;
  const doneCount = rows.filter((r) => r.status === 'Completed').length;
  const lateCount = rows.filter((r) => r.delayS !== null && r.delayS >= ON_TIME_S && r.row.actual.exitS === null && r.row.actual.cancelledS === null).length;
  const sc = SCENARIOS.find((s) => s.id === scenario);

  // A scenario fixes its own difficulty; otherwise the selector decides.
  const effectiveDifficulty: DifficultyId = sc?.difficulty ?? difficulty;
  const onGenerate = () => {
    const typed = seed.trim() === '' ? undefined : Number(seed);
    const useSeed = typed !== undefined && Number.isFinite(typed) ? typed : (sc?.seed ?? undefined);
    // Measuring a busy shift's journeys takes a moment: say so first, then work.
    setGenerating(true);
    setTimeout(() => {
      shift.generate(useSeed, effectiveDifficulty);
      setViewing(null);
      setGenerating(false);
    }, 30);
  };

  return (
    <section className="panel timetable-panel" aria-label="Shift and timetable" data-testid="timetable-panel">
      <h2>
        Shift timetable
        <span className="tt-title-info" data-testid="shift-info">
          {cur?.status === 'running' ? ` · Shift ${cur.id} running` : cur ? ` · Shift ${cur.id} ${cur.status}` : tt ? ' · not started' : ''}
          {tt ? ` · ${tt.services.length} services · ${shift.clock(0)}–${shift.clock(tt.endS)}` : ''}
          {running ? ` · ${doneCount} done · ${lateCount} delayed` : ''}
          {tt?.difficulty && DIFFICULTIES[tt.difficulty as DifficultyId] ? ` · ${DIFFICULTIES[tt.difficulty as DifficultyId].label}` : ''}
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
                Difficulty{' '}
                <select
                  aria-label="Difficulty"
                  value={effectiveDifficulty}
                  disabled={sc?.difficulty !== null && sc?.difficulty !== undefined}
                  onChange={(e) => setDifficulty(e.target.value as DifficultyId)}
                  title={DIFFICULTIES[effectiveDifficulty].description}
                  data-testid="difficulty"
                >
                  {DIFFICULTY_IDS.map((d) => (
                    <option key={d} value={d}>
                      {DIFFICULTIES[d].label} ({DIFFICULTIES[d].countRange[0]}–{DIFFICULTIES[d].countRange[1]} trains)
                    </option>
                  ))}
                </select>
              </label>
              <label className="tt-seed">
                Seed{' '}
                <input aria-label="Timetable seed" className="seed-input" value={seed} placeholder={sc?.seed !== null && sc ? String(sc.seed) : 'random'} inputMode="numeric" onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, '').slice(0, 9))} />
              </label>
              <button type="button" onClick={onGenerate} disabled={generating} data-testid="generate-timetable">
                {generating ? 'Generating…' : 'Generate timetable'}
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
                disabled={!shift.draft || generating}
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
                  <TimetableRow key={r.entryId} entry={r} shift={shift} isNext={r.entryId === nextId} onCancel={() => shift.cancelService(r.row.service.id)} />
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

function TimetableRow({ entry, shift, isNext, onCancel }: { entry: TimetableEntry; shift: ShiftController; isNext: boolean; onCancel: () => void }) {
  const row = entry.row;
  const s = row.service;
  const a = row.actual;
  const hc = entry.headcode;
  const incoming = entry.leg === 'incoming';
  const outgoing = entry.leg === 'outgoing';
  const siding = entry.siding ? shift.sidingName(entry.siding) : '';
  const selected = shift.selectedServiceId === entry.entryId;
  const late = entry.delayS !== null && entry.delayS >= ON_TIME_S;
  const finished = outgoing ? a.exitS !== null : incoming ? entry.status === 'Completed' : a.exitS !== null;
  const canCancel = !outgoing && shift.running && a.entryS === null && a.cancelledS === null && a.failedReason === null;
  return (
    <tr
      className={`tt-row st-${statusClass(entry.status)}${selected ? ' selected' : ''}${isNext ? ' next' : ''}${late && !finished && a.cancelledS === null ? ' late-row' : ''}${entry.leg !== 'whole' ? ` tt-${entry.leg}` : ''}`}
      data-testid={`tt-row-${hc}`}
      data-status={entry.status}
      data-leg={entry.leg}
      onClick={() => shift.select(entry.entryId)}
      aria-selected={selected}
    >
      {outgoing ? <td className="mono tcell">—</td> : <TimeCell shift={shift} sched={s.entryS} actual={a.entryS} delayS={row.delays.entry} />}
      <td className="mono hc">
        <button type="button" className="link" aria-label={`Select service ${hc}`} onClick={(e) => { e.stopPropagation(); shift.select(entry.entryId); }}>
          {hc}
        </button>
        {outgoing ? <span className="muted tt-link" data-testid={`tt-link-${hc}`}> (Outgoing train for {entry.forHeadcode})</span> : null}
        {incoming ? <span className="muted tt-link" data-testid={`tt-link-${hc}`}> (ECS into {siding})</span> : null}
        {isNext ? (
          <span className="badge next-badge" title="The next service due to enter">
            NEXT
          </span>
        ) : null}
      </td>
      <td>{entry.trainClass}</td>
      <td className="mono unit" title={stockLabel({ model: s.model, formation: s.formation })}>
        {s.model}
        <span className="muted"> {s.formation.replace('-car', 'c')}</span>
      </td>
      <td>{outgoing ? siding : placeName(s.origin)}</td>
      <td>{incoming ? siding : placeName(s.destination)}</td>
      <td data-testid={`plat-${hc}`}>{entry.leg === 'whole' ? (
        <>
          {s.platform ? s.platform.replace('PLAT', 'Pl ') : '—'}
          {s.platform && a.actualPlatform && a.actualPlatform !== s.platform ? <span className="plat-changed" title="Platform used instead of the planned one"> → {a.actualPlatform.replace('PLAT', 'Pl ')}</span> : null}
        </>
      ) : siding}</td>
      {incoming ? (
        <TimeCell shift={shift} sched={s.arrivalS} actual={a.arrivalS} delayS={row.delays.arrival} label="stabled " />
      ) : outgoing ? (
        <td className="mono tcell">—</td>
      ) : s.stops ? (
        <TimeCell shift={shift} sched={s.arrivalS} actual={a.arrivalS} delayS={row.delays.arrival} />
      ) : (
        <TimeCell shift={shift} sched={s.passS} actual={a.passS} delayS={a.passS !== null && s.passS !== null ? a.passS - s.passS : null} label="pass " />
      )}
      {outgoing ? <TimeCell shift={shift} sched={s.departureS} actual={a.departureS} delayS={row.delays.departure} /> : incoming ? <td className="mono tcell">—</td> : s.stops ? <TimeCell shift={shift} sched={s.departureS} actual={a.departureS} delayS={row.delays.departure} /> : <td className="mono tcell">—</td>}
      <td data-testid={`tt-status-${hc}`}>
        <span className={`st-dot st-${statusClass(entry.status)}`} aria-hidden="true" /> {entry.status}
      </td>
      <td className={`mono delay${late ? ' late' : ''}`} data-testid={`tt-delay-${hc}`}>
        {entry.delayS === null ? '—' : delayText(entry.delayS)}
      </td>
      <td>
        {canCancel ? (
          <button type="button" className="mini" onClick={(e) => { e.stopPropagation(); onCancel(); }} aria-label={`Cancel ${hc}`}>
            Cancel
          </button>
        ) : null}
      </td>
    </tr>
  );
}
