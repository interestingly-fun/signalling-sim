import { useState, useSyncExternalStore } from 'react';
import {
  CLASS_PROFILES,
  TRAIN_CLASSES,
  defaultStock,
  getModel,
  modelsForClass,
  permissionsFor,
  stockLabel,
  stockPerformance,
  planServices,
  platformOptions,
  type Train,
  type TrainClassId,
} from '../../engine';
import type { ShiftController } from '../sim/shift';
import { STEP_SECONDS, type Simulation } from '../sim/simulation';
import { TrainPerformance } from './TrainPerformance';

interface Props {
  readonly sim: Simulation;
  /** Message log. */
  readonly onMessage: (kind: 'ok' | 'error' | 'info', text: string) => void;
  readonly onPauseResume: () => void;
  readonly onReset: () => void;
  /** A shift is running: trains come from the timetable, so manual creation is off. */
  readonly shiftRunning?: boolean;
}

const MPH = 2.23694;
export const SPEEDS = [1, 2, 4, 8, 16, 32] as const;

/** Boundary names for the pickers. */
const ENTRIES = [
  { id: 'N-IN', label: 'Northbridge (N-IN)' },
  { id: 'W-IN', label: 'Westford (W-IN)' },
  { id: 'M-IO', label: 'Merefield (M-IO)' },
];
const EXITS = [
  { id: 'N-OUT', label: 'Northbridge (N-OUT)' },
  { id: 'W-OUT', label: 'Westford (W-OUT)' },
  { id: 'M-IO', label: 'Merefield (M-IO)' },
];

/** Platform text, e.g. "PLAT1" or "—". */
export const platformText = (t: Train): string => (t.stop ? `${t.stop.platform}${t.stop.phase === 'departed' ? ' (left)' : ''}` : '—');

export const dwellText = (t: Train): string => {
  if (!t.stop) return '—';
  if (t.stop.phase === 'pending') return `${t.stop.dwellS} s (not yet stopped)`;
  if (t.stop.phase === 'dwelling') return `${Math.ceil(t.stop.remainingS)} s remaining of ${t.stop.dwellS} s`;
  return `${t.stop.dwellS} s (finished)`;
};

function nextHeadcode(sim: Simulation, cls: number): string {
  const used = new Set(sim.activeTrains.map((t) => t.spec.headcode));
  for (let n = 1; n < 100; n++) {
    const h = `${cls}A${String(n).padStart(2, '0')}`;
    if (!used.has(h)) return h;
  }
  return `${cls}Z99`;
}

/** Create / start / pause / reset controls and the active-train list. */
export function TrainPanel({ sim, onMessage, onPauseResume, onReset, shiftRunning = false }: Props) {
  useSyncExternalStore(sim.subscribeFrame, sim.getFrame);
  const sig = useSyncExternalStore(sim.subscribeSig, sim.getSig);
  const ctx = sim.ctx;

  const [cls, setCls] = useState<TrainClassId>(2);
  const [headcode, setHeadcode] = useState('2A01');
  const [origin, setOrigin] = useState('W-IN');
  const [destination, setDestination] = useState('N-OUT');
  const [stops, setStops] = useState(true);
  const [platform, setPlatform] = useState('');
  const [dwell, setDwell] = useState<number>(CLASS_PROFILES[2].defaultDwellS);
  const [planId, setPlanId] = useState('');
  const [modelId, setModelId] = useState<string>(defaultStock(2).model);
  const [ignoreLimits, setIgnoreLimits] = useState(false);
  const [formationId, setFormationId] = useState<string>(defaultStock(2).formation);

  const models = modelsForClass(cls);
  const model = models.find((m) => m.id === modelId) ?? models[0]!;
  const formation = model.formations.find((f) => f.id === formationId) ?? model.formations[0]!;
  const stock = { model: model.id, formation: formation.id };
  const perms = permissionsFor(cls, model.id);
  const lengthM = stockPerformance(stock).lengthM;
  const wantsStop = stops && perms.canStop;
  const platforms = wantsStop ? platformOptions(ctx, sig, sim.trains, { trainClass: cls, origin, destination, lengthM, model: model.id }) : [];
  const platformId = platforms.some((p) => p.id === platform) ? platform : (platforms[0]?.id ?? '');
  const plans = planServices(ctx, { trainClass: cls, origin, destination, platform: wantsStop ? platformId || '__none__' : null, lengthM, model: model.id });
  const plan = plans.find((p) => p.id === planId) ?? plans[0];

  let problem = '';
  if (plans.length === 0) {
    if (cls === 1 && !perms.canStop && (origin === 'M-IO' || destination === 'M-IO')) problem = `A Class 1 ${model.name} never uses the branch.`;
    else if (wantsStop && platforms.length === 0) problem = 'No platform is available: none is reachable on this journey, or they are occupied or already assigned.';
    else problem = `No valid route from ${origin} to ${destination} for a Class ${cls} train.`;
  } else if (origin === destination) problem = 'Origin and destination are the same.';

  const changeClass = (c: TrainClassId) => {
    setCls(c);
    const d = defaultStock(c);
    setModelId(d.model);
    setFormationId(d.formation);
    setHeadcode(nextHeadcode(sim, c));
    setDwell(CLASS_PROFILES[c].defaultDwellS);
    setStops(c === 2); // regional trains stop by default; ECS and expresses run through unless asked
  };

  const onCreate = () => {
    const r = sim.create({ headcode, trainClass: cls, origin, destination, platform: wantsStop ? platformId : null, dwellS: wantsStop ? dwell : 0, planId: plan?.id, model: model.id, formation: formation.id, ...(ignoreLimits ? { ignoreRestrictions: true } : {}) });
    if (r.ok) {
      onMessage('ok', `Train ${r.train.spec.headcode} (Class ${cls}, ${stockLabel(stock)}) created outside ${origin}${wantsStop ? `, stopping at ${platformId} for ${dwell} s` : ', running through'}. Routes to set: ${r.plan.manual.join(', ') || 'none'}.`);
      setHeadcode(nextHeadcode(sim, cls));
    } else onMessage('error', r.reason);
  };

  const mode = sim.mode;
  const live = sim.activeTrains;
  const waiting = live.filter((t) => !t.started);

  return (
    <div className="panel-body train-panel" data-testid="train-panel">
      {shiftRunning ? (
        <p className="note warn" data-testid="manual-locked">A shift is running: trains come from the timetable, so the test-train form is hidden. Abandon the shift to create test trains.</p>
      ) : null}
      <fieldset className="train-create" hidden={shiftRunning}>
        <legend>Create train</legend>
        <div className="train-settings">
          <label>
            Class{' '}
            <select aria-label="Train class" value={cls} onChange={(e) => changeClass(Number(e.target.value) as TrainClassId)}>
              {TRAIN_CLASSES.map((c) => (
                <option key={c} value={c}>
                  {c} · {CLASS_PROFILES[c].name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Model{' '}
            <select
              aria-label="Train model"
              value={model.id}
              onChange={(e) => {
                setModelId(e.target.value);
                setFormationId(getModel(e.target.value)?.formations[0]?.id ?? '');
              }}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Formation{' '}
            <select aria-label="Formation" value={formation.id} onChange={(e) => setFormationId(e.target.value)}>
              {model.formations.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.id} · {f.lengthM} m
                </option>
              ))}
            </select>
          </label>
          <label title="Test only: the driver does not slow for speed restrictions, so the overspeed warning can be seen. Signals are still obeyed.">
            <input type="checkbox" aria-label="Ignore speed restrictions" checked={ignoreLimits} onChange={(e) => setIgnoreLimits(e.target.checked)} /> Ignore speed limits (test)
          </label>
          <label>
            Headcode{' '}
            <input
              className="headcode-input"
              value={headcode}
              maxLength={4}
              aria-label="Headcode"
              onChange={(e) => setHeadcode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))}
            />
          </label>
          <label>
            From{' '}
            <select aria-label="Origin" value={origin} onChange={(e) => setOrigin(e.target.value)}>
              {ENTRIES.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            To{' '}
            <select aria-label="Destination" value={destination} onChange={(e) => setDestination(e.target.value)}>
              {EXITS.filter((b) => b.id !== origin).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input type="checkbox" aria-label="Station stop" checked={wantsStop} disabled={!perms.canStop} onChange={(e) => setStops(e.target.checked)} /> Station stop
          </label>
          {wantsStop ? (
            <>
              <label>
                Platform{' '}
                <select aria-label="Platform" value={platformId} onChange={(e) => setPlatform(e.target.value)}>
                  {platforms.length === 0 ? <option value="">none available</option> : null}
                  {platforms.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Dwell (s){' '}
                <input className="dwell-input" type="number" min={0} max={600} step={5} value={dwell} aria-label="Dwell time in seconds" onChange={(e) => setDwell(Number(e.target.value))} />
              </label>
            </>
          ) : null}
          <label>
            Route{' '}
            <select aria-label="Route" value={plan?.id ?? ''} onChange={(e) => setPlanId(e.target.value)}>
              {plans.length === 0 ? <option value="">no valid route</option> : null}
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!perms.canStop ? <p className="note">A {model.name} working as Class 1 never stops, never uses platform loops and never uses the branch. Class 387 and 350 can work as Class 1 with stops and the branch.</p> : null}
        {plan && !problem ? <p className="note" data-testid="plan-moves">Signaller sets: {plan.manual.join(', ') || 'nothing'}.</p> : null}
        {problem ? (
          <p className="note warn" role="alert" data-testid="create-problem">
            {problem}
          </p>
        ) : null}
        <button type="button" onClick={onCreate} disabled={shiftRunning || problem !== '' || plan === undefined || (wantsStop && platformId === '')} data-testid="create-train">
          Create train
        </button>
      </fieldset>

      <div className="train-controls">
        <button type="button" onClick={() => sim.startAll()} disabled={waiting.length === 0} data-testid="start-all">
          Start all waiting
        </button>
        <button type="button" onClick={onPauseResume} disabled={mode !== 'running' && mode !== 'paused'} data-testid="pause">
          {mode === 'paused' ? 'Resume' : 'Pause'}
        </button>
        <button type="button" onClick={onReset} disabled={shiftRunning || sim.trains.length === 0} data-testid="reset-train">
          Reset scenario
        </button>
        <button type="button" onClick={() => sim.clearCompleted()} disabled={!sim.trains.some((t) => t.finished)} data-testid="clear-completed">
          Clear completed
        </button>
        <label className="train-settings">
          Speed{' '}
          <select
            value={sim.speedFactor}
            aria-label="Simulation speed"
            onChange={(e) => sim.setSpeed(Number(e.target.value))}
          >
            {SPEEDS.map((f) => (
              <option key={f} value={f}>
                {f}×
              </option>
            ))}
          </select>
        </label>
      </div>

      <table className="train-list" aria-label="Active trains" data-testid="train-list">
        <thead>
          <tr>
            <th>Train</th>
            <th>Cl</th>
            <th>Status</th>
            <th>Speed</th>
            <th>Platform</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sim.trains.length === 0 ? (
            <tr>
              <td colSpan={6} className="muted">
                No trains. Create one above.
              </td>
            </tr>
          ) : null}
          {sim.trains.map((t) => (
            <tr key={t.id} className={`${sim.train?.id === t.id ? 'selected' : ''}${t.finished ? ' done' : ''}`} data-testid={`row-${t.spec.headcode}`}>
              <td>
                <button type="button" className="link" onClick={() => sim.select(t.id)} aria-label={`Select ${t.spec.headcode}`}>
                  {t.spec.headcode}
                </button>
              </td>
              <td title={stockLabel(t.spec.stock)}>
                {t.spec.trainClass} <span className="muted">{t.spec.stock ? `${t.spec.stock.model}·${t.spec.stock.formation.replace('-car', 'c')}` : ''}</span>
              </td>
              <td data-testid={`status-${t.spec.headcode}`}>{sim.isPaused && !t.finished && t.started ? 'paused' : t.status}</td>
              <td>{t.finished ? '—' : `${(t.speedMs * MPH).toFixed(0)} mph`}</td>
              <td>{t.stop ? `${t.stop.platform}${t.stop.phase === 'dwelling' ? ` ${Math.ceil(t.stop.remainingS)}s` : ''}` : '—'}</td>
              <td className="row-actions">
                {!t.started && !t.finished ? (
                  <button type="button" onClick={() => sim.start(t.id)} aria-label={`Start ${t.spec.headcode}`}>
                    Start
                  </button>
                ) : null}
                {(!t.started || t.finished) && (t.frontM < 0 || t.finished) ? (
                  <button type="button" onClick={() => sim.remove(t.id)} aria-label={`Remove ${t.spec.headcode}`}>
                    Remove
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note">
        Fixed {Math.round(1 / STEP_SECONDS)} Hz simulation; pause stops every train and every dwell timer. Trains obey signals and follow only the routes you set. A new train waits outside its boundary until started, then enters at its class entry speed
        ({TRAIN_CLASSES.map((c) => `Class ${c}: ${CLASS_PROFILES[c].entrySpeedMs} m/s`).join(', ')}; never more than three quarters of the model's top speed) when the line ahead allows.
      </p>
    </div>
  );
}

/** Details of the selected train: shown in the Inspector panel (the performance inspector). */
export function TrainDetails({ sim, shift }: { readonly sim: Simulation; readonly shift?: ShiftController }) {
  useSyncExternalStore(sim.subscribeFrame, sim.getFrame);
  const t = sim.train;
  if (!t || sim.trains.length === 0) return null;
  return <TrainPerformance sim={sim} shift={shift} train={t} />;
}
