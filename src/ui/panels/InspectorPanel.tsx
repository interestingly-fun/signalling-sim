import type { ReactNode } from 'react';
import {
  ASPECT_NAMES,
  computeUnderlyingAspects,
  explainAspect,
  pointBlock,
  signalOverride,
  validateRoute,
  type Aspect,
  type PointPosition,
  type SignallingContext,
  type SignallingState,
} from '../../engine';
import { cancelBlock } from '../routeUi';
import { describeAttachment, type Selection } from '../selection';

interface Props {
  readonly ctx: SignallingContext;
  readonly state: SignallingState;
  readonly aspects: Readonly<Record<string, Aspect>>;
  readonly selection: Selection | null;
  /** Test control: asks the interlocking to move one point. It refuses if the point is locked or occupied. */
  readonly onMovePoint: (pointId: string, position: PointPosition) => void;
  /** Test control: marks a section occupied or clear. There are no trains yet. */
  readonly onToggleOccupied: (sectionId: string) => void;
  readonly onPreviewRoute: (routeId: string) => void;
  readonly onCancelRoute: (routeId: string) => void;
  /** Force an automatic signal to Danger (true) or return it to automatic (false). */
  readonly onSetOverride: (signalId: string, forced: boolean) => void;
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="kv">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function AspectBadge({ aspect }: { aspect: Aspect }) {
  return (
    <span className="aspect-badge">
      <svg width="26" height="14" aria-hidden="true">
        {aspect === 'double-yellow' ? (
          <>
            <circle className="lamp yellow" cx="8" cy="7" r="4.4" />
            <circle className="lamp yellow" cx="18" cy="7" r="4.4" />
          </>
        ) : (
          <circle className={`lamp ${aspect}`} cx="13" cy="7" r="5.2" />
        )}
      </svg>
      {ASPECT_NAMES[aspect]}
    </span>
  );
}

export function InspectorPanel({ ctx, state, aspects, selection, onMovePoint, onToggleOccupied, onPreviewRoute, onCancelRoute, onSetOverride }: Props) {
  const net = ctx.net;

  if (!selection) {
    return <div className="panel-body muted">Click a track section, point or signal on the diagram to inspect it. Click a manual signal to start setting a route.</div>;
  }

  if (selection.kind === 'section') {
    const s = net.sections.get(selection.id);
    if (!s) return null;
    const occupied = (state.network.sectionOccupancy[s.id] ?? null) !== null;
    const reservedBy = state.sectionLocks[s.id];
    const traffic = s.traffic === 'AB' ? 'A → B only' : s.traffic === 'BA' ? 'B → A only' : 'both directions';
    return (
      <div className="panel-body">
        <h3>
          Section <code>{s.id}</code>
        </h3>
        <dl>
          <Row k="Line">{s.line}</Row>
          <Row k="Length">{s.lengthM} m</Row>
          <Row k="Traffic">{traffic}</Row>
          {s.platform ? <Row k="Platform">{net.platforms.get(s.platform)?.name}</Row> : null}
          {s.crosses?.length ? <Row k="Crosses">{s.crosses.join(', ')} (diamond – no connection)</Row> : null}
          <Row k="End A">{describeAttachment(net, net.attachmentAt({ section: s.id, end: 'A' }))}</Row>
          <Row k="End B">{describeAttachment(net, net.attachmentAt({ section: s.id, end: 'B' }))}</Row>
          {(['A', 'B'] as const).map((end) => {
            const sig = net.signalLeaving({ section: s.id, end });
            return sig ? (
              <Row key={end} k={`Signal at ${end}`}>
                {sig.name} ({sig.type})
              </Row>
            ) : null;
          })}
          <Row k="Reserved">{reservedBy !== undefined ? `Yes – route ${reservedBy}` : 'No'}</Row>
          <Row k="State">{occupied ? 'Occupied (test marker – no train)' : 'Clear'}</Row>
        </dl>
        <h4>Test control – there are no trains yet</h4>
        <button type="button" onClick={() => onToggleOccupied(s.id)}>
          {occupied ? 'Clear test occupancy' : 'Mark occupied (test)'}
        </button>
      </div>
    );
  }

  if (selection.kind === 'point') {
    const p = net.points.get(selection.id);
    if (!p) return null;
    const pos = state.network.pointPositions[p.id] ?? 'normal';
    const lockedBy = state.pointLocks[p.id];
    const block = pointBlock(ctx, state, p.id);
    const target: PointPosition = pos === 'normal' ? 'reverse' : 'normal';
    const junction = [...net.junctions.values()].find((j) => j.points.includes(p.id));
    const blockText =
      block?.kind === 'locked' ? `Locked by route ${block.owner}: it cannot move.` : block?.kind === 'occupied' ? `Section ${block.section} is occupied: it cannot move.` : null;
    return (
      <div className="panel-body">
        <h3>
          Points <code>{p.id}</code>
        </h3>
        <dl>
          <Row k="Name">{p.name}</Row>
          {junction ? <Row k="Junction">{junction.name}</Row> : null}
          <Row k="Toe">{p.toe.section} (end {p.toe.end})</Row>
          <Row k="Normal leg">{p.normal.section} (end {p.normal.end})</Row>
          <Row k="Reverse leg">{p.reverse.section} (end {p.reverse.end})</Row>
          <Row k="Set">{pos === 'normal' ? `Normal → toe connects to ${p.normal.section}` : `Reverse → toe connects to ${p.reverse.section}`}</Row>
          <Row k="Lock">{lockedBy !== undefined ? `Locked by route ${lockedBy}` : 'Free'}</Row>
        </dl>
        <h4>Test control – points normally move only through route setting</h4>
        <button type="button" disabled={block !== null} onClick={() => onMovePoint(p.id, target)}>
          Move to {target}
        </button>
        {blockText ? <p className="note">{blockText}</p> : null}
      </div>
    );
  }

  const sig = net.signals.get(selection.id);
  if (!sig) return null;
  const aspect = aspects[sig.id] ?? 'red';
  const explanation = explainAspect(ctx, state, sig.id, aspects);
  const forced = signalOverride(state, sig.id) === 'FORCED_DANGER';
  const underlying = forced ? computeUnderlyingAspects(ctx, state)[sig.id] : undefined;
  const from = ctx.from(sig.id);
  const established = state.routes[sig.id];
  const cancelReason = established !== undefined ? cancelBlock(ctx, state, established) : null;
  return (
    <div className="panel-body">
      <h3>
        Signal <code>{sig.id}</code>
      </h3>
      <dl>
        <Row k="Type">{sig.type === 'manual' ? 'Manual – routes are set by the signaller' : 'Automatic – no player control'}</Row>
        <Row k="Stands at">
          {sig.at.section} (end {sig.at.end}), governs trains leaving through that end
        </Row>
        <Row k="Aspect">
          <AspectBadge aspect={aspect} />
        </Row>
        {sig.type === 'automatic' ? (
          <Row k="Control">{forced ? <strong className="override-text">MANUAL OVERRIDE – forced to Danger</strong> : 'Automatic'}</Row>
        ) : null}
        <Row k="Because">{explanation.reason}</Row>
        {forced && underlying ? <Row k="Would show">{ASPECT_NAMES[underlying]} (automatic calculation, suppressed)</Row> : null}
        {sig.type === 'manual' ? <Row k="Route">{established !== undefined ? `${established} established` : 'None set'}</Row> : null}
      </dl>
      {sig.type === 'automatic' ? (
        <>
          <button type="button" data-testid="override-button" className={forced ? 'override-on' : ''} onClick={() => onSetOverride(sig.id, !forced)}>
            {forced ? 'Return to Automatic' : 'Force to Danger'}
          </button>
          <p className="note">
            {forced ? 'Trains will stop at this signal until it is returned to automatic. Trains already past it are not affected.' : 'Holds trains at this signal. Routes, points and occupancy are not changed.'}
          </p>
        </>
      ) : null}
      {established !== undefined ? (
        <>
          <button type="button" disabled={cancelReason !== null} onClick={() => onCancelRoute(established)}>
            Cancel route {established}
          </button>
          {cancelReason ? <p className="note">{cancelReason}</p> : null}
        </>
      ) : null}
      <h4>
        {sig.type === 'manual' ? 'Routes from here' : 'Movement protected'} ({from.length})
      </h4>
      <ul className="route-links">
        {from.map((r) => {
          const status = established === r.id ? 'set' : sig.type === 'manual' ? (validateRoute(ctx, state, r.id) ? 'blocked' : 'available') : 'automatic';
          return (
            <li key={r.id}>
              {sig.type === 'manual' ? (
                <button type="button" className="link" onClick={() => onPreviewRoute(r.id)}>
                  {r.from} → {r.to}
                </button>
              ) : (
                <code>
                  {r.from} → {r.to}
                </code>
              )}{' '}
              <span className={`tag ${status}`}>{status}</span> <span className="muted">{r.description}</span>
            </li>
          );
        })}
        {from.length === 0 ? <li className="muted">None</li> : null}
      </ul>
    </div>
  );
}
