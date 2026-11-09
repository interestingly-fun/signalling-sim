import { useMemo } from 'react';
import { validateRoute, type DerivedRoute, type SignallingContext, type SignallingState } from '../../engine';
import { cancelBlock, type Message, type RouteUi } from '../routeUi';

interface Props {
  readonly ctx: SignallingContext;
  readonly state: SignallingState;
  readonly ui: RouteUi;
  /** Most recent feedback from the interlocking or the selection logic. */
  readonly message: Message | null;
  /** Preview a movement (select its entrance and show its path). Sets nothing. */
  readonly onChooseRoute: (routeId: string) => void;
  /** Same as clicking the exit signal on the diagram: ask the interlocking to set this movement now. */
  readonly onSetEntranceRoute: (routeId: string) => void;
  readonly onCancelRoute: (routeId: string) => void;
  readonly onClear: () => void;
}

type Status = 'set' | 'available' | 'blocked' | 'automatic';

function statusOf(ctx: SignallingContext, state: SignallingState, r: DerivedRoute): { status: Status; why?: string } {
  if (state.routes[r.from] === r.id) return { status: 'set' };
  if (ctx.net.signals.get(r.from)?.type !== 'manual') return { status: 'automatic' };
  const why = validateRoute(ctx, state, r.id)?.message;
  return why ? { status: 'blocked', why } : { status: 'available' };
}

const pointsText = (r: DerivedRoute): string => (r.points.length === 0 ? 'none' : r.points.map((p) => `${p.point} ${p.position === 'normal' ? 'N' : 'R'}`).join(', '));

/**
 * Route control and the table of every movement the topology allows.
 * All verdicts come from the signalling engine; this panel only displays them
 * and forwards the signaller's choices.
 */
export function RouteTablePanel({ ctx, state, ui, message, onChooseRoute, onSetEntranceRoute, onCancelRoute, onClear }: Props) {
  const groups = useMemo(() => {
    const map = new Map<string, DerivedRoute[]>();
    for (const r of ctx.routes) map.set(r.from, [...(map.get(r.from) ?? []), r]);
    return [...map.entries()];
  }, [ctx]);

  const proposal = ui.routeId !== null ? ctx.route(ui.routeId) : undefined;
  const proposalIsSet = proposal !== undefined && state.routes[proposal.from] === proposal.id;
  const entranceRoutes = ui.entrance !== null ? ctx.from(ui.entrance) : [];
  const established = Object.values(state.routes);

  return (
    <div className="panel-body route-panel">
      {message ? (
        <div className={`banner ${message.kind}`} role="status">
          {message.text}
        </div>
      ) : null}

      {ui.entrance === null ? (
        <p className="muted guide">
          <strong>1.</strong> Click a manual signal (ringed) on the diagram. <strong>2.</strong> Click the exit signal: the route is set at once if the interlocking allows it. Esc cancels.
        </p>
      ) : (
        <div className="selection-box">
          <div className="selection-head">
            Entrance <code>{ui.entrance}</code>
            {proposal ? (
              <>
                {' '}
                → exit <code>{proposal.to}</code>
              </>
            ) : (
              <span className="muted"> – click an exit signal on the diagram</span>
            )}
          </div>
          {entranceRoutes.length > 0 ? (
            <div className="choices">
              {entranceRoutes.map((r) => {
                const st = statusOf(ctx, state, r);
                return (
                  <button
                    key={r.id}
                    type="button"
                    className={`choice${r.id === ui.routeId ? ' active' : ''}`}
                    title={st.why ?? `Set ${r.description}`}
                    onClick={() => (st.status === 'set' ? onChooseRoute(r.id) : onSetEntranceRoute(r.id))}
                  >
                    → {r.to} <span className={`tag ${st.status}`}>{st.status}</span>
                    <span className="choice-desc">{r.description}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
          {proposal ? (
            <div className="proposal">
              <div>
                <span className="muted">Sections</span> {proposal.sections.join(' › ')}
              </div>
              <div>
                <span className="muted">Points</span> {pointsText(proposal)}
              </div>
              {proposal.features.length > 0 ? (
                <div>
                  <span className="muted">Via</span> {proposal.features.join(', ')}
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="actions">
            {proposal && proposalIsSet ? (
              <button type="button" disabled={cancelBlock(ctx, state, proposal.id) !== null} title={cancelBlock(ctx, state, proposal.id) ?? undefined} onClick={() => onCancelRoute(proposal.id)}>
                Cancel route
              </button>
            ) : null}
            <button type="button" onClick={onClear}>
              Clear selection
            </button>
          </div>
        </div>
      )}

      <h4>Established routes ({established.length})</h4>
      {established.length === 0 ? (
        <p className="muted compact">None. All manual signals are at Red.</p>
      ) : (
        <ul className="established">
          {established.map((id) => {
            const r = ctx.route(id);
            if (!r) return null;
            const block = cancelBlock(ctx, state, id);
            return (
              <li key={id}>
                <code>
                  {r.from} → {r.to}
                </code>
                <span className="muted">{r.description}</span>
                <button type="button" disabled={block !== null} title={block ?? 'Cancel this route and return its signal to Red'} onClick={() => onCancelRoute(id)}>
                  Cancel
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <h4>All movements ({ctx.routes.length})</h4>
      <div className="route-scroll">
        {groups.map(([from, list]) => (
          <div key={from} className="route-group">
            <div className="route-from">
              {from} <span className="muted">{ctx.net.signals.get(from)?.type}</span>
            </div>
            {list.map((r) => {
              const st = statusOf(ctx, state, r);
              const body = (
                <>
                  <span className="route-to">→ {r.to}</span>
                  <span className="route-desc">{r.description}</span>
                  <span className={`tag ${st.status}`}>{st.status}</span>
                </>
              );
              return st.status === 'automatic' ? (
                <div key={r.id} className="route-row static">
                  {body}
                </div>
              ) : (
                <button key={r.id} type="button" className={`route-row${r.id === ui.routeId ? ' active' : ''}`} title={st.why} onClick={() => onChooseRoute(r.id)}>
                  {body}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
