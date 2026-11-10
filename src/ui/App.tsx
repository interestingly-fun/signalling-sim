import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
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
  type PointPosition,
} from '../engine';
import { ashcombeLayout, validateLayout } from '../layout';
import { SignallingDiagram } from './diagram/SignallingDiagram';
import { TrainLayer } from './diagram/TrainLayer';
import { TrainDetails, TrainPanel } from './panels/TrainPanel';
import type { Simulation } from './sim/simulation';
import { useShift, useSimulation } from './sim/useSimulation';
import { ServiceDetails, ShiftClock, TimetablePanel } from './panels/TimetablePanel';
import { InspectorPanel } from './panels/InspectorPanel';
import { RouteTablePanel } from './panels/RouteTablePanel';
import { LogPanel } from './panels/LogPanel';
import { OperationsStrip } from './panels/OperationsStrip';
import type { LogCategory } from './sim/eventLog';
import { clickSignal, destinationsFor, emptyRouteUi, previewMovement, submitCancel, establishMovement, type Message, type RouteUi } from './routeUi';
import { sameSelection, type Selection } from './selection';

// The network, its route table and its drawing are built once. All are immutable.
const network = buildNetwork(ashcombeDefinition);
const ctx = createSignallingContext(network, deriveRoutes(network));
const topologyIssues = validateNetworkDef(ashcombeDefinition);
const layoutIssues = validateLayout(network, ashcombeLayout);


export function App() {
  // The simulation owns the signalling state: the train changes it every step, the signaller between steps.
  const sim = useSimulation(ctx, () => createSignallingState(network));
  const shift = useShift(sim);
  useSyncExternalStore(shift.subscribe, shift.getVersion);
  const sig = useSyncExternalStore(sim.subscribeSig, sim.getSig);
  const setSig = sim.setSig;
  const [selection, setSelection] = useState<Selection | null>(null);
  const [routeUi, setRouteUi] = useState<RouteUi>(emptyRouteUi);
  const [latest, setLatest] = useState<Message | null>(null);
  const [showLabels, setShowLabels] = useState(true);
  const [hoverSignal, setHoverSignal] = useState<string | null>(null);

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
    if (s === null) setRouteUi(emptyRouteUi); // click on empty diagram clears a half-made route selection
  };

  const onSignalClick = (signalId: string) => {
    setSelection({ kind: 'signal', id: signalId });
    const cur = sim.getSig();
    const update = clickSignal(ctx, cur, routeUi, signalId);
    if (update.state) setSig(update.state);
    setRouteUi(update.ui);
    push(update.message);
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
    const update = establishMovement(ctx, sim.getSig(), { entrance: route.from, routeId: null }, routeId);
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
          <span className="topbar-name">ASHCOMBE JUNCTION</span>
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
          <div className="diagram-toolbar">
            <label>
              <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} /> Section names
            </label>
            <button type="button" onClick={reset}>
              Reset
            </button>
            <Legend />
          </div>
          <SignallingDiagram
            net={network}
            layout={ashcombeLayout}
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
            onSignalHover={setHoverSignal}
            overlay={<TrainLayer net={network} layout={ashcombeLayout} sim={sim} onSelectTrain={onSelectTrain} />}
          />
        </section>

        <OperationsStrip ctx={ctx} sim={sim} shift={shift} sig={sig} />

        <section className="lower">
          <TimetablePanel sim={sim} shift={shift} />
          <LogPanel log={log} />
        </section>

        <section className="panels">
          <div className="panel train-panel-wrap">
            <h2>Trains</h2>
            <TrainPanel sim={sim} onMessage={(kind, text) => (kind === 'error' ? push({ kind, text }, 'train') : note(text, 'train'))} onPauseResume={onPauseResume} onReset={onResetTrain} shiftRunning={shift.running} />
          </div>
          <div className="panel">
            <h2>Inspector</h2>
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
          </div>
          <div className="panel">
            <h2>Routes</h2>
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
          </div>
          <div className="panel">
            <h2>About</h2>
            <div className="panel-body notes">
              <p>
                <strong>Layout limits:</strong> Platform 1 is reachable only by eastbound trains, so trains from Northbridge can use Platform 2 only. Westford ↔ Merefield through running is impossible (it would
                need a reversal).
              </p>
              <p>
                <strong>Not implemented:</strong> passengers, ticketing and economics. The test controls in the inspector can still mark sections occupied.
              </p>
              <p className="disclaimer">Educational game simulation. Not a certified or operationally safe signalling system.</p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
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
