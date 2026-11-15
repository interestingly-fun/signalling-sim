import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  ashcombeDefinition,
  buildNetwork,
  checkLockInvariants,
  computeAspects,
  createSignallingContext,
  createSignallingState,
  deriveRoutes,
  movePoint,
  setSignalOverride,
  setTestOccupancy,
  validateCancelWithTrains,
  validateNetworkDef,
  validateRoute,
  signalName,
  type NetworkDef,
  type PointPosition,
  type SignallingState,
} from '../engine';
import { ashcombeLayout, validateLayout, type LayoutDef } from '../layout';
import { SignallingDiagram } from './diagram/SignallingDiagram';
import { TrainLayer } from './diagram/TrainLayer';
import { SPEEDS, TrainDetails, TrainPanel } from './panels/TrainPanel';
import type { Simulation } from './sim/simulation';
import { useShift, useSimulation } from './sim/useSimulation';
import { ServiceDetails, ShiftClock, TimetablePanel } from './panels/TimetablePanel';
import { InspectorPanel } from './panels/InspectorPanel';
import { RouteTablePanel } from './panels/RouteTablePanel';
import { LogPanel } from './panels/LogPanel';
import { GenerationInfo } from './panels/GenerationInfo';
import { OperationsStrip } from './panels/OperationsStrip';
import { CompactInspector } from './panels/CompactInspector';
import type { LogCategory } from './sim/eventLog';
import { clickBuffer, clickSignal, destinationsFor, emptyRouteUi, previewMovement, submitCancel, establishMovement, type Message, type RouteUi } from './routeUi';
import { sameSelection, type Selection } from './selection';

/** Everything that differs between maps: the logical network, its drawing and a few words. The workstation itself is shared. */
export interface WorkstationDef {
  readonly name: string;
  readonly diagramLabel: string;
  readonly definition: NetworkDef;
  readonly layout: LayoutDef;
  /** localStorage key of this map's shift history. */
  readonly storageKey: string;
  readonly about: ReactNode;
  /** Manual train creation (the test Trains panel) is meaningful on this map. */
  readonly manualTrains: boolean;
}

/** Builds the signalling workstation for a map. The network, its route table and its drawing are built once per map and are immutable. */
export function createWorkstation(def: WorkstationDef): () => JSX.Element {
const network = buildNetwork(def.definition);
const ctx = createSignallingContext(network, deriveRoutes(network));
const topologyIssues = validateNetworkDef(def.definition);
const layoutIssues = validateLayout(network, def.layout);

function App() {
  // The simulation owns the signalling state: the train changes it every step, the signaller between steps.
  const sim = useSimulation(ctx, () => createSignallingState(network));
  const shift = useShift(sim, def.storageKey);
  useSyncExternalStore(shift.subscribe, shift.getVersion);
  const sig = useSyncExternalStore(sim.subscribeSig, sim.getSig);
  const setSig = sim.setSig;
  const [selection, setSelection] = useState<Selection | null>(null);
  const [routeUi, setRouteUi] = useState<RouteUi>(emptyRouteUi);
  const [latest, setLatest] = useState<Message | null>(null);
  const [showLabels, setShowLabels] = useState(true);
  const [hoverSignal, setHoverSignal] = useState<string | null>(null);
  // Optional areas (Phase 8.5). Hiding them only hides the display: events keep being recorded and the simulation is untouched.
  const [showTesting, setShowTesting] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const log = shift.log;
  /**
   * Feedback for an action. It is shown at once in the Routes panel (`latest`); only refusals and
   * notes go to the event log, because state changes (routes, points, signals) are logged from the
   * state itself and would otherwise appear twice.
   */
  const push = (m: Message | undefined, category: LogCategory = 'route') => {
    if (!m) return;
    setLatest(m);
    if (m.kind === 'error') log.add(category, 'error', m.text);
  };
  const note = (text: string, category: LogCategory = 'system') => {
    setLatest({ kind: 'info', text });
    log.add(category, 'info', text);
  };

  // Aspects are always computed from the state. Nothing stores or sets them.
  const aspects = useMemo(() => computeAspects(ctx, sig), [sig]);
  const lockProblems = useMemo(() => checkLockInvariants(ctx, sig), [sig]);

  // While choosing an exit, hovering a reachable signal previews the route to it (nothing is set until it is clicked).
  const hoverRoute = routeUi.entrance !== null && routeUi.routeId === null && hoverSignal !== null ? ctx.between(routeUi.entrance, hoverSignal)[0] : undefined;
  const proposalRoute = routeUi.routeId !== null ? ctx.route(routeUi.routeId) : hoverRoute;
  const proposalIsSet = proposalRoute !== undefined && sig.routes[proposalRoute.from] === proposalRoute.id;
  const proposal = proposalRoute && !proposalIsSet ? proposalRoute : null;
  const proposalBlocked = proposal !== null && validateRoute(ctx, sig, proposal.id) !== null;
  const destinations = useMemo(() => new Set(destinationsFor(ctx, routeUi.entrance)), [routeUi.entrance]);

  const consistent = topologyIssues.length === 0 && layoutIssues.length === 0;
  const routesSet = Object.keys(sig.routes).length;

  const select = (s: Selection | null) => {
    setSelection((prev) => (sameSelection(prev, s) ? prev : s));
    if (s === null) {
      setRouteUi(emptyRouteUi); // click on empty diagram clears a half-made route selection
      sim.select(null); // ...and the selected train
    }
  };

  const onSignalClick = (signalId: string) => {
    setSelection({ kind: 'signal', id: signalId });
    const cur = sim.getSig();
    const update = clickSignal(ctx, cur, routeUi, signalId, sim.trains);
    if (update.state) setSig(update.state);
    setRouteUi(update.ui);
    push(update.message);
  };

  const onBufferClick = (boundaryId: string) => {
    const update = clickBuffer(ctx, sim.getSig(), routeUi, boundaryId, sim.trains);
    if (update.state) setSig(update.state);
    setRouteUi(update.ui);
    if (update.message) push(update.message);
  };

  const onChooseRoute = (routeId: string) => {
    const update = previewMovement(ctx, sig, routeId);
    const route = ctx.route(routeId);
    if (route) setSelection({ kind: 'signal', id: route.from });
    setRouteUi(update.ui);
    push(update.message);
  };

  /** Establish a movement from the Routes panel: the same as clicking its exit signal. */
  const onSetEntranceRoute = (routeId: string) => {
    const route = ctx.route(routeId);
    if (!route) return;
    const update = establishMovement(ctx, sim.getSig(), { entrance: route.from, routeId: null }, routeId, sim.trains);
    if (update.state) setSig(update.state);
    setRouteUi(update.ui);
    push(update.message);
  };

  const onCancelRoute = (routeId: string) => {
    const cur = sim.getSig();
    const approach = validateCancelWithTrains(ctx, cur, sim.trains, routeId);
    if (approach) {
      push({ kind: 'error', text: approach.message });
      return;
    }
    const r = submitCancel(ctx, cur, routeUi, routeId);
    setSig(r.state);
    setRouteUi(r.ui);
    push(r.message);
  };

  const onClear = () => {
    setRouteUi(emptyRouteUi);
    push({ kind: 'info', text: 'Selection cleared.' });
  };

  const onMovePoint = (pointId: string, position: PointPosition) => {
    const r = movePoint(ctx, sim.getSig(), pointId, position);
    if (r.ok) {
      setSig(r.state);
      setLatest({ kind: 'info', text: `Test control: ${r.message}` });
    } else {
      push({ kind: 'error', text: r.rejection.message }, 'point');
    }
  };

  const onSetOverride = (signalId: string, forced: boolean) => {
    const r = setSignalOverride(ctx, sim.getSig(), signalId, forced ? 'FORCED_DANGER' : 'AUTOMATIC');
    if (r.ok) {
      setSig(r.state);
      setLatest({ kind: forced ? 'info' : 'ok', text: r.message });
    } else {
      push({ kind: 'error', text: r.rejection.message }, 'signal');
    }
  };

  const onToggleOccupied = (sectionId: string) => {
    const cur = sim.getSig();
    const occupied = (cur.network.sectionOccupancy[sectionId] ?? null) === null;
    setSig(setTestOccupancy(cur, sectionId, occupied));
    note(`Test control: section ${sectionId} marked ${occupied ? 'occupied' : 'clear'} (no train).`);
  };

  const reset = () => {
    if (shift.running) {
      push({ kind: 'error', text: `Reset is not available while Shift ${shift.current?.id ?? ''} is running. Abandon the shift first (Shift timetable panel).` }, 'shift');
      return;
    }
    log.silent(() => {
      sim.reset();
      setSig(createSignallingState(network));
    });
    setRouteUi(emptyRouteUi);
    setSelection(null);
    note('Reset: trains removed, all routes cancelled, signal overrides removed, points normal, test occupancy cleared.');
  };

  const onSelectTrain = (trainId: string) => {
    sim.select(trainId);
    shift.selectByTrain(trainId);
  };

  const onPauseResume = () => (sim.mode === 'paused' ? sim.resume() : sim.pause());
  const onResetTrain = () => {
    log.silent(() => sim.reset());
    note('Scenario reset: all trains removed; their locks, routes and occupancy released. Routes you set that no train had passed are kept.', 'train');
  };

  // Escape abandons a half-made route selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRouteUi(emptyRouteUi);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-title">
          <span className="topbar-name">{def.name.toUpperCase()}</span>
          <span className="topbar-sub">Control area</span>
        </div>
        <div className="topbar-status">
          <ShiftClock sim={sim} shift={shift} />
          <ModeChip sim={sim} />
          <span
            className={`chip ${consistent && lockProblems.length === 0 ? 'ok' : 'bad'}`}
            title={[`Diagram ↔ topology: ${consistent ? 'consistent' : 'problems'}`, `Interlocking: ${lockProblems.length === 0 ? 'consistent' : 'problems'}`, ...topologyIssues, ...layoutIssues, ...lockProblems].join('\n')}
            data-testid="checks-chip"
          >
            {consistent && lockProblems.length === 0 ? 'Checks: consistent' : `Checks: ${topologyIssues.length + layoutIssues.length + lockProblems.length} problem(s)`}
          </span>
        </div>
        <div className="topbar-stats">
          {network.sections.size} sections · {network.points.size} points · {network.signals.size} signals · {ctx.routes.length} movements · {routesSet} route{routesSet === 1 ? '' : 's'} set
        </div>
      </header>

      <main className="main">
        <section className="diagram-wrap" aria-label="Signalling diagram">
          <SignallingDiagram
            label={`${def.diagramLabel} signalling diagram`}
            net={network}
            layout={def.layout}
            state={sig}
            aspects={aspects}
            selection={selection}
            entrance={routeUi.entrance}
            destinations={destinations}
            proposal={proposal}
            proposalBlocked={proposalBlocked}
            showSectionLabels={showLabels}
            onSelect={select}
            onSignalClick={onSignalClick}
            onBufferClick={onBufferClick}
            onSignalHover={setHoverSignal}
            overlay={<TrainLayer net={network} layout={def.layout} sim={sim} onSelectTrain={onSelectTrain} />}
            hudLeft={<CompactInspector sim={sim} />}
            hudRight={
              <>
                <button type="button" className={`toggle-btn${showTesting ? ' on' : ''}`} aria-pressed={showTesting} onClick={() => setShowTesting((v) => !v)} data-testid="toggle-testing">
                  {showTesting ? 'Disable testing information' : 'Enable testing information'}
                </button>
                <button type="button" className={`toggle-btn${showLog ? ' on' : ''}`} aria-pressed={showLog} onClick={() => setShowLog((v) => !v)} data-testid="toggle-log">
                  {showLog ? 'Disable the Event Log' : 'Enable the Event Log'}
                </button>
              </>
            }
          />
          <div className="diagram-footer">
            <label>
              <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} /> Section names
            </label>
            <button type="button" onClick={reset}>
              Reset
            </button>
            <FeedbackBar latest={latest} selection={selection} sig={sig} onCancelRoute={onCancelRoute} />
            <Legend />
          </div>
        </section>

        <section className={`lower${showLog ? '' : ' no-log'}`}>
          <TimetablePanel sim={sim} shift={shift} />
          {showLog ? <LogPanel log={log} /> : null}
        </section>

        {showTesting ? (
          <section className="testing" aria-label="Testing information" data-testid="testing-info">
            <h2 className="testing-title">Testing information</h2>
            <OperationsStrip ctx={ctx} sim={sim} shift={shift} sig={sig} />
            <GenerationInfo ctx={ctx} shift={shift} />
            <div className="panels">
              {def.manualTrains ? (
              <details className="panel train-panel-wrap" open>
                <summary>Trains</summary>
                <TrainPanel sim={sim} onMessage={(kind, text) => (kind === 'error' ? push({ kind, text }, 'train') : note(text, 'train'))} onPauseResume={onPauseResume} onReset={onResetTrain} shiftRunning={shift.running} />
              </details>
              ) : (
              <details className="panel" open>
                <summary>Trains</summary>
                <div className="panel-body notes"><p>Every train on this map is a timetabled terminating service: use the shift timetable to start one. The Trains test panel (manual through trains) is not available because no train can run through the terminus.</p>
                  <div className="train-controls">
                    <button type="button" onClick={onPauseResume} disabled={sim.mode !== 'running' && sim.mode !== 'paused'} data-testid="pause">{sim.mode === 'paused' ? 'Resume' : 'Pause'}</button>
                    <label className="train-settings">Speed{' '}<select value={sim.speedFactor} aria-label="Simulation speed" onChange={(e) => sim.setSpeed(Number(e.target.value))} data-testid="speed">{SPEEDS.map((f) => (<option key={f} value={f}>{f}×</option>))}</select></label>
                  </div>
                </div>
              </details>
              )}
              <details className="panel" open>
                <summary>Inspector</summary>
                <ServiceDetails sim={sim} shift={shift} />
                <TrainDetails sim={sim} shift={shift} />
                <InspectorPanel
                  ctx={ctx}
                  state={sig}
                  aspects={aspects}
                  selection={selection}
                  onMovePoint={onMovePoint}
                  onToggleOccupied={onToggleOccupied}
                  onPreviewRoute={onChooseRoute}
                  onCancelRoute={onCancelRoute}
                  onSetOverride={onSetOverride}
                />
              </details>
              <details className="panel" open>
                <summary>Routes</summary>
                <RouteTablePanel
                  ctx={ctx}
                  state={sig}
                  ui={routeUi}
                  message={latest}
                  onChooseRoute={onChooseRoute}
                  onSetEntranceRoute={onSetEntranceRoute}
                  onCancelRoute={onCancelRoute}
                  onClear={onClear}
                />
              </details>
              <details className="panel" open>
                <summary>About</summary>
                <div className="panel-body notes">
                  {def.about}
                  <p>
                    <strong>Not implemented:</strong> passengers, ticketing and economics. The test controls in the inspector can still mark sections occupied.
                  </p>
                </div>
              </details>
            </div>
          </section>
        ) : null}
        <p className="disclaimer app-disclaimer">Educational game simulation. Not a certified or operationally safe signalling system.</p>
      </main>
    </div>
  );
}

/** The latest action's feedback (always visible, even with the testing information hidden) and a quick way to cancel the selected signal's route. */
function FeedbackBar({ latest, selection, sig, onCancelRoute }: { latest: Message | null; selection: Selection | null; sig: SignallingState; onCancelRoute: (routeId: string) => void }) {
  const routeId = selection?.kind === 'signal' ? sig.routes[selection.id] : undefined;
  const route = routeId !== undefined ? ctx.route(routeId) : undefined;
  return (
    <div className="feedback" role="status" aria-live="polite" data-testid="feedback-bar">
      {latest ? <span className={`feedback-msg ${latest.kind}`} data-testid="feedback-msg" title={latest.text}>{latest.text}</span> : null}
      {route && routeId !== undefined ? (
        <span className="feedback-route">
          Route {signalName(network, route.from)} → {signalName(network, route.to)} is set
          <button type="button" onClick={() => onCancelRoute(routeId)} data-testid="quick-cancel">
            Cancel route
          </button>
        </span>
      ) : null}
    </div>
  );
}

  return App;
}

function ModeChip({ sim }: { sim: Simulation }) {
  useSyncExternalStore(sim.subscribeFrame, sim.getFrame);
  const text = { 'no-train': 'No trains', ready: 'Trains waiting', running: `${sim.activeTrains.length} train${sim.activeTrains.length === 1 ? '' : 's'} running`, paused: 'Paused', finished: 'All trains finished' }[sim.mode];
  return <span className={`chip ${sim.mode === 'running' ? 'ok' : 'idle'}`}>{text}</span>;
}

function Lamp({ kind }: { kind: 'red' | 'yellow' | 'green' }) {
  return <circle cx="7" cy="7" r="4.6" className={`lamp ${kind}`} />;
}

function Legend() {
  return (
    <div className="legend" aria-label="Legend">
      <span className="legend-item">
        <i className="sw clear" /> clear
      </span>
      <span className="legend-item">
        <i className="sw set" /> route set
      </span>
      <span className="legend-item">
        <i className="sw route" /> proposed
      </span>
      <span className="legend-item">
        <i className="sw occupied" /> occupied
      </span>
      <span className="legend-item">
        <svg width="14" height="14" aria-hidden="true">
          <Lamp kind="red" />
        </svg>
        <svg width="14" height="14" aria-hidden="true">
          <Lamp kind="yellow" />
        </svg>
        <svg width="24" height="14" aria-hidden="true">
          <circle cx="6" cy="7" r="3.6" className="lamp yellow" />
          <circle cx="16" cy="7" r="3.6" className="lamp yellow" />
        </svg>
        <svg width="14" height="14" aria-hidden="true">
          <Lamp kind="green" />
        </svg>
        R / Y / YY / G
      </span>
      <span className="legend-item">
        <svg width="22" height="18" aria-hidden="true">
          <circle cx="11" cy="9" r="7.6" className="signal-ring" />
          <circle cx="11" cy="9" r="4.6" className="lamp red" />
        </svg>
        manual
        <svg width="14" height="14" aria-hidden="true">
          <Lamp kind="red" />
        </svg>
        automatic
      </span>
      <span className="legend-item">
        <svg width="22" height="18" aria-hidden="true">
          <rect x="2" y="2" width="18" height="14" rx="2" className="signal-override" />
          <circle cx="11" cy="9" r="4.6" className="lamp red" />
        </svg>
        forced to Danger (FD)
      </span>
      <span className="legend-item">
        <b className="pn">N</b>/<b className="pr">R</b> points
        <svg width="12" height="14" aria-hidden="true" className="point-lock">
          <g transform="translate(6 6)">
            <path d="M-2.4 0 v-2.2 a2.4 2.4 0 0 1 4.8 0 v2.2" />
            <rect x={-3.6} y={0} width={7.2} height={5.4} rx={1} />
          </g>
        </svg>
        locked
      </span>
    </div>
  );
}

/** Ashcombe Junction (Phases 1 to 10.5). */
export const App = createWorkstation({
  name: 'Ashcombe Junction',
  diagramLabel: 'Ashcombe Junction',
  definition: ashcombeDefinition,
  layout: ashcombeLayout,
  storageKey: 'ashcombe.shifts',
  manualTrains: true,
  about: (
    <p>
      <strong>Layout limits:</strong> Platform 1 is reachable only by eastbound trains, so trains from Northbridge can use Platform 2 only. Westford ↔ Merefield through running is impossible (it would need a
      reversal).
    </p>
  ),
});
