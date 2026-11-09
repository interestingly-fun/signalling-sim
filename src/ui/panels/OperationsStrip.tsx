import { forcedSignals, type SignallingContext, type SignallingState, type Train } from '../../engine';
import { placeName, type ShiftController } from '../sim/shift';
import type { Simulation } from '../sim/simulation';
import { useSlowFrame } from '../sim/useSlowFrame';

interface Props {
  readonly ctx: SignallingContext;
  readonly sim: Simulation;
  readonly shift: ShiftController;
  readonly sig: SignallingState;
}

const APPROACHING = new Set(['approaching', 'approaching platform', 'braking']);
const HELD = new Set(['waiting to enter', 'stopped at signal']);
const AT_PLATFORM = new Set(['stopped at platform', 'dwelling', 'ready to depart']);

const mmss = (s: number): string => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;

/**
 * One compact row that answers "what needs my attention?": trains approaching, held, at a platform,
 * routes set, locked points, forced signals, occupied sections, late services and the next service
 * due. Read-only; it decides nothing.
 */
export function OperationsStrip({ ctx, sim, shift, sig }: Props) {
  useSlowFrame(sim, 250);
  const live = sim.trains.filter((t) => !t.finished && t.frontM >= -50);
  const pick = (set: Set<string>): Train[] => live.filter((t) => set.has(t.status));
  const approaching = pick(APPROACHING);
  const held = pick(HELD);
  const platform = pick(AT_PLATFORM);
  const routes = Object.values(sig.routes).map((id) => ctx.route(id)).filter((r) => r !== undefined).map((r) => `${r.from}→${r.to}`);
  const locked = Object.keys(sig.pointLocks).sort();
  const forced = forcedSignals(sig);
  const occupied = Object.entries(sig.network.sectionOccupancy).filter(([, v]) => v !== null).map(([k]) => k).sort();
  const rows = shift.running ? shift.rows() : [];
  const late = rows.filter((r) => r.delayS !== null && r.delayS >= 60 && r.actual.exitS === null && r.actual.cancelledS === null);
  const next = rows.find((r) => r.actual.entryS === null && r.actual.cancelledS === null && r.actual.failedReason === null && r.actual.trainId === null);
  const select = (t: Train) => {
    sim.select(t.id);
    shift.selectByTrain(t.id);
  };
  const trains = (list: Train[]) =>
    list.length === 0 ? (
      <span className="none">none</span>
    ) : (
      list.map((t) => (
        <button key={t.id} type="button" className="ops-train" onClick={() => select(t)} title={`${t.status}${t.holdReason ? ': ' + t.holdReason : ''}`}>
          {t.spec.headcode}
        </button>
      ))
    );
  const text = (list: string[], max = 6) => (list.length === 0 ? <span className="none">none</span> : <span title={list.join(', ')}>{list.length > max ? `${list.slice(0, max).join(', ')} +${list.length - max}` : list.join(', ')}</span>);
  return (
    <div className="ops-strip" role="status" aria-label="Operations summary" data-testid="ops-strip">
      <div className="ops-item" data-testid="ops-approaching">
        <span className="ops-label">Approaching</span>
        {trains(approaching)}
      </div>
      <div className={`ops-item${held.length ? ' attn' : ''}`} data-testid="ops-held">
        <span className="ops-label">Held / waiting</span>
        {trains(held)}
      </div>
      <div className="ops-item" data-testid="ops-platform">
        <span className="ops-label">At platform</span>
        {trains(platform)}
      </div>
      <div className="ops-item" data-testid="ops-routes">
        <span className="ops-label">Routes set</span>
        {text(routes, 4)}
      </div>
      <div className="ops-item" data-testid="ops-locked">
        <span className="ops-label">Points locked</span>
        {text(locked)}
      </div>
      <div className={`ops-item${forced.length ? ' attn' : ''}`} data-testid="ops-forced">
        <span className="ops-label">Forced Danger</span>
        {text(forced)}
      </div>
      <div className="ops-item" data-testid="ops-occupied">
        <span className="ops-label">Occupied</span>
        {text(occupied, 5)}
      </div>
      {shift.running ? (
        <>
          <div className={`ops-item${late.length ? ' attn' : ''}`} data-testid="ops-late">
            <span className="ops-label">Delayed</span>
            {late.length === 0 ? <span className="none">none</span> : late.map((r) => <span key={r.service.id}>{r.service.headcode}</span>)}
          </div>
          <div className="ops-item" data-testid="ops-next">
            <span className="ops-label">Next due</span>
            {next ? (
              <span>
                {next.service.headcode} {shift.clock(next.service.entryS)} from {placeName(next.service.origin)} ({shift.nowS < next.service.entryS ? `in ${mmss(next.service.entryS - shift.nowS)}` : 'due'})
              </span>
            ) : (
              <span className="none">none</span>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
