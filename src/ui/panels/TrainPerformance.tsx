import { accelerationAt, computeAspects, frontSection, getFormation, getModel, classProfile, msToMph, rearSection, signalAhead, stockLabel, type Train } from '../../engine';
import { placeName, type ShiftController } from '../sim/shift';
import type { Simulation } from '../sim/simulation';
import { useSlowFrame } from '../sim/useSlowFrame';

const MPH = 2.23694;

/** Direction of travel in words, from the line the front is on and where the train came from. */
export function directionText(sim: Simulation, t: Train): string {
  const sec = frontSection(t) ?? t.path[0]?.section ?? '';
  const line = sim.ctx.net.sections.get(sec)?.line;
  const o = t.spec.origin;
  if (line === 'UP') return 'Eastbound (UP main)';
  if (line === 'DOWN') return 'Westbound (DOWN main)';
  if (line === 'BRANCH') return o === 'M-IO' ? 'Towards the junction (from Merefield)' : 'Towards Merefield';
  return o === 'N-IN' ? 'Westbound' : 'Eastbound';
}

const aspectName = (a: string): string => (a === 'red' ? 'Danger' : a === 'yellow' ? 'Yellow' : a === 'double-yellow' ? 'Double yellow' : 'Green');
const aspectNote = (a: string): string => (a === 'red' ? 'stop at this signal' : a === 'yellow' ? 'next signal may be at Danger' : 'preparing for a more restrictive signal');

/** What the train is doing with its speed, in words (from the movement state and how far it is from the target speed). */
function speedState(t: Train): string {
  if (!t.started) return 'waiting';
  if (t.state === 'stopped') return 'stopped';
  if (t.state === 'braking') return `braking towards ${Math.round(t.targetSpeedMs * MPH)} mph`;
  if (t.state === 'accelerating') return `accelerating towards ${Math.round(t.targetSpeedMs * MPH)} mph`;
  return 'holding speed';
}

const stopText = (t: Train, plat: (id: string) => string): string => {
  const s = t.stop;
  if (!s) return 'Runs through (no stop)';
  const name = plat(s.platform);
  if (s.phase === 'pending') return `${name}: not yet stopped`;
  if (s.phase === 'dwelling') return `${name}: dwelling, ${Math.ceil(s.remainingS)} s left of ${s.dwellS} s`;
  if (s.phase === 'done') return `${name}: dwell finished`;
  return `${name}: departed`;
};

/**
 * Compact performance inspector for the selected train: identity, physical characteristics and what the train
 * is doing now. Read-only. It shows the numbers the movement engine actually uses (from the rolling-stock database).
 */
export function TrainPerformance({ sim, shift, train: t }: { sim: Simulation; shift?: ShiftController; train: Train }) {
  useSlowFrame(sim, 200);
  const live = !t.finished;
  const spec = t.spec;
  const model = spec.stock ? getModel(spec.stock.model) : undefined;
  const formation = spec.stock ? getFormation(spec.stock.model, spec.stock.formation) : undefined;
  const ctx = sim.ctx;
  const sig = sim.getSig();
  const ahead = live ? signalAhead(ctx.net, sig, computeAspects(ctx, sig), t) : null;
  const plat = (id: string): string => ctx.net.platforms.get(id)?.name ?? id;
  const row = shift?.rows().find((r) => r.actual.trainId === t.id);
  const v = t.speedMs;
  const maxMs = spec.maxSpeedMs;
  const brakeDist = (v * v) / (2 * spec.serviceBrakeMs2);
  const front = live ? frontSection(t) : null;
  const rear = live ? rearSection(t) : null;
  const next = live ? t.speedInfo.next : null;
  const status = sim.isPaused && live && t.started ? 'paused' : t.status;
  return (
    <section className="train-details perf" aria-label="Selected train" data-testid="train-details">
      <h3>
        Train <span data-testid="ro-headcode">{spec.headcode}</span> <span className="muted perf-stock" data-testid="ro-stock">{stockLabel(spec.stock)}</span>
      </h3>

      {live && t.speedInfo.overspeed ? (
        <div className="perf-warn" role="alert" data-testid="ro-overspeed">
          Overspeed: {Math.round(v * MPH)} mph, permitted {Math.round(t.speedInfo.permittedMs * MPH)} mph ({t.speedInfo.permittedLabel}) at {front ?? 'the boundary'}
        </div>
      ) : null}

      <h4>Identification</h4>
      <dl className="train-readout">
        <dt>Operating class</dt>
        <dd data-testid="ro-class">
          {spec.trainClass} · {classProfile(spec.trainClass).name}
        </dd>
        <dt>Train model</dt>
        <dd data-testid="ro-model">{model ? `${model.name} · ${model.description}` : 'Generic test train'}</dd>
        <dt>Formation</dt>
        <dd data-testid="ro-formation">{formation ? `${formation.id} (${formation.cars} cars)` : '—'}</dd>
      </dl>

      <h4>Physical characteristics</h4>
      <dl className="train-readout">
        <dt>Length</dt>
        <dd data-testid="ro-length">{spec.lengthM} m</dd>
        <dt>Maximum speed</dt>
        <dd data-testid="ro-maxspeed">
          {Math.round(msToMph(maxMs))} mph
        </dd>
        <dt>Current speed</dt>
        <dd data-testid="ro-speed">
          {live ? `${(v * MPH).toFixed(0)} mph (${v.toFixed(1)} m/s)` : '—'}
          <span className="speedbar" aria-hidden="true">
            <span style={{ width: `${Math.min(100, (v / maxMs) * 100)}%` }} />
          </span>
        </dd>
        <dt>Acceleration</dt>
        <dd data-testid="ro-accel">
          {spec.accelerationMs2.toFixed(2)} m/s² from standing, {accelerationAt(spec, maxMs).toFixed(2)} at top speed
          {live && t.started ? <span className="muted"> · available now {accelerationAt(spec, v).toFixed(2)}</span> : null}
        </dd>
        <dt>Service braking</dt>
        <dd data-testid="ro-brake">
          {spec.serviceBrakeMs2.toFixed(2)} m/s²{live && v > 0.5 ? <span className="muted"> · stopping from here: {Math.round(brakeDist)} m</span> : null}
        </dd>
      </dl>

      <h4>Speed and restrictions</h4>
      <dl className="train-readout">
        <dt>Permitted speed</dt>
        <dd data-testid="ro-permitted" className={live && t.speedInfo.overspeed ? 'over' : undefined}>
          {live ? `${Math.round(t.speedInfo.permittedMs * MPH)} mph · ${t.speedInfo.permittedLabel}` : '—'}
        </dd>
        <dt>Speed state</dt>
        <dd data-testid="ro-speedstate">{live ? speedState(t) : '—'}</dd>
        <dt>Next restriction</dt>
        <dd data-testid="ro-restriction">
          {!live ? '—' : next ? (
            <>
              {Math.round(next.limitMs * MPH)} mph ({next.label}) in {Math.round(next.distanceM)} m
              {next.brakingM > 1 ? <span className="muted"> · braking needs {Math.round(next.brakingM)} m</span> : null}
            </>
          ) : (
            'none ahead'
          )}
        </dd>
      </dl>

      <h4>Current state</h4>
      <dl className="train-readout">
        <dt>Status</dt>
        <dd data-testid="ro-status">{status}</dd>
        <dt>Movement</dt>
        <dd data-testid="ro-state">{t.state}</dd>
        <dt>Section (front)</dt>
        <dd data-testid="ro-section">{live ? (front ?? 'outside the boundary') : '—'}</dd>
        <dt>Section (rear)</dt>
        <dd data-testid="ro-rear">{live ? (rear ?? 'outside the area') : '—'}</dd>
        <dt>Direction</dt>
        <dd data-testid="ro-direction">{live ? directionText(sim, t) : '—'}</dd>
        <dt>Destination</dt>
        <dd data-testid="ro-destination">{placeName(spec.destination)}</dd>
        <dt>Station</dt>
        <dd data-testid="ro-platform">
          {stopText(t, plat)}
          {row?.service.departureS != null && t.stop && t.stop.phase !== 'departed' ? <span className="muted"> · due away {shift?.clock(row.service.departureS)}</span> : null}
        </dd>
        <dt>Signal ahead</dt>
        <dd data-testid="ro-ahead">
          {ahead ? (
            <>
              {ahead.signal} · {aspectName(ahead.aspect)} · {Math.round(ahead.distanceM)} m
              {ahead.aspect !== 'green' ? <span className="caution" data-testid="ro-restrictive"> · {aspectNote(ahead.aspect)}</span> : null}
            </>
          ) : live ? (
            'none before the exit'
          ) : (
            '—'
          )}
        </dd>
        {t.holdReason ? (
          <>
            <dt>Held</dt>
            <dd data-testid="ro-hold">{t.holdReason}</dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}
