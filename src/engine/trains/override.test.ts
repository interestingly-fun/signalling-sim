import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ashcombeDefinition,
  buildNetwork,
  checkLockInvariants,
  computeAspects,
  computeUnderlyingAspects,
  createSignallingContext,
  createSignallingState,
  explainAspect,
  forcedSignals,
  JOURNEYS,
  requestRoute,
  setSignalOverride,
  setTestOccupancy,
  signalOverride,
  spawnTrain,
  stepTrain,
  testTrainSpec,
  type SignallingState,
  type Train,
  type TrainEvent,
} from '../index';

const net = buildNetwork(ashcombeDefinition);
const ctx = createSignallingContext(net);
const fresh = () => createSignallingState(net);
const L = (id: string): number => net.sections.get(id)?.lengthM ?? NaN;
const sum = (...ids: string[]): number => ids.reduce((n, id) => n + L(id), 0);
/** Distance along the westbound path to the end of DN10 (signal D4). */
const D4_END = sum('DNE2', 'DNE1', 'DN1', 'DN2', 'DN3', 'DN4', 'DN5', 'DN6', 'DN7', 'DN8', 'DN9', 'DX', 'DN10');

const force = (s: SignallingState, id: string): SignallingState => {
  const r = setSignalOverride(ctx, s, id, 'FORCED_DANGER');
  assert.ok(r.ok);
  return r.state;
};
const release = (s: SignallingState, id: string): SignallingState => {
  const r = setSignalOverride(ctx, s, id, 'AUTOMATIC');
  assert.ok(r.ok);
  return r.state;
};
function routed(): SignallingState {
  let s = fresh();
  for (const [a, b] of [['D2', 'D3'], ['D3', 'D4']] as const) {
    const r = requestRoute(ctx, s, a, b);
    assert.ok(r.ok);
    s = r.state;
  }
  return s;
}
const asp = (s: SignallingState) => computeAspects(ctx, s);

describe('forcing an automatic signal to Danger', () => {
  test('it shows Red even though its normal calculation is permissive, and the calculation is preserved', () => {
    const s = force(fresh(), 'UE1');
    assert.equal(computeUnderlyingAspects(ctx, fresh())['UE1'], 'green');
    assert.equal(asp(fresh())['UE1'], 'green');
    assert.equal(asp(s)['UE1'], 'red');
    assert.equal(computeUnderlyingAspects(ctx, s)['UE1'], 'green', 'the automatic calculation is untouched');
    assert.equal(signalOverride(s, 'UE1'), 'FORCED_DANGER');
    assert.equal(signalOverride(s, 'U6'), 'AUTOMATIC');
    assert.deepEqual(forcedSignals(s), ['UE1']);
  });

  test('the signals behind see a Red signal ahead: Yellow, Double Yellow, Green', () => {
    const r = requestRoute(ctx, force(fresh(), 'UE1'), 'U5', 'U6');
    assert.ok(r.ok);
    const a = asp(r.state);
    assert.equal(a['U6'], 'yellow');
    assert.equal(a['U5'], 'double-yellow');
  });

  test('returning to automatic restores exactly the normal aspects', () => {
    const s = release(force(fresh(), 'U6'), 'U6');
    assert.deepEqual(asp(s), asp(fresh()));
    assert.deepEqual(s.signalOverrides, {});
  });

  test('normal occupancy-based logic still works, with and without overrides elsewhere', () => {
    const routedU5 = requestRoute(ctx, force(fresh(), 'D1'), 'U5', 'U6');
    assert.ok(routedU5.ok);
    const s = setTestOccupancy(routedU5.state, 'UP11', true);
    const a = asp(s);
    assert.equal(a['U5'], 'red', 'occupied UP11 still stops U5');
    assert.equal(a['D1'], 'red');
    assert.equal(computeUnderlyingAspects(ctx, s)['D1'], 'yellow', 'D1 underneath: D2 is Red so Single Yellow');
  });

  test('only automatic signals can be overridden; manual (U5 included, since Phase 5) and unknown are refused with the state untouched', () => {
    const s = fresh();
    const u5 = setSignalOverride(ctx, s, 'U5', 'FORCED_DANGER');
    assert.ok(!u5.ok && u5.rejection.code === 'NOT_AUTOMATIC' && u5.state === s);
    const m = setSignalOverride(ctx, s, 'U2', 'FORCED_DANGER');
    assert.equal(m.ok, false);
    assert.equal(m.state, s);
    assert.ok(!m.ok && m.rejection.code === 'NOT_AUTOMATIC');
    const u = setSignalOverride(ctx, s, 'ZZ', 'FORCED_DANGER');
    assert.ok(!u.ok && u.rejection.code === 'NO_SUCH_SIGNAL');
  });

  test('forcing an already-forced signal, or releasing an automatic one, is a no-op returning the same state', () => {
    const s = force(fresh(), 'U6');
    const again = setSignalOverride(ctx, s, 'U6', 'FORCED_DANGER');
    assert.ok(again.ok && again.state === s);
    const none = setSignalOverride(ctx, fresh(), 'U6', 'AUTOMATIC');
    assert.ok(none.ok);
  });

  test('it changes nothing but the override: occupancy, routes, locks and points are the same objects', () => {
    let s = routed();
    s = setTestOccupancy(s, 'UP5', true);
    const forced = force(s, 'D1');
    assert.equal(forced.network, s.network);
    assert.equal(forced.routes, s.routes);
    assert.equal(forced.sectionLocks, s.sectionLocks);
    assert.equal(forced.pointLocks, s.pointLocks);
    assert.deepEqual(checkLockInvariants(ctx, forced), []);
  });

  test('the explanation says the signal is forced, and a normal Red still gets its own reason', () => {
    const s = setTestOccupancy(force(fresh(), 'D1'), 'UP12', true);
    assert.match(explainAspect(ctx, s, 'D1').reason, /Forced to Danger/);
    assert.match(explainAspect(ctx, s, 'U6').reason, /UP12 is occupied/);
  });

  test('a manual route is not released or changed when an automatic signal on it is forced', () => {
    const s = routed();
    const forced = force(s, 'D4');
    assert.deepEqual(forced.routes, s.routes);
    assert.equal(asp(forced)['D3'], 'yellow', 'D3 sees D4 forced Red; its own route is still proven');
  });
});

// -------------------------------------------------------------------------------------------
describe('trains and a forced signal', () => {
  interface W {
    sig: SignallingState;
    train: Train;
    events: TrainEvent[];
    time: number;
  }
  function world(sig: SignallingState): W {
    const sp = spawnTrain(net, sig, testTrainSpec(JOURNEYS[0]));
    assert.ok(sp.ok);
    return { sig: sp.sig, train: { ...sp.train, started: true }, events: [], time: 0 };
  }
  function run(w: W, until: (w: W) => boolean, maxS = 400, each?: (w: W) => void): void {
    for (let t = 0; t < maxS && !until(w); t += 0.05) {
      const r = stepTrain(ctx, w.sig, w.train, 0.05);
      w.sig = r.sig;
      w.train = r.train;
      w.events.push(...r.events);
      w.time += 0.05;
      each?.(w);
    }
  }
  // D1 stands at the end of DN1, after the two outer approach sections.
  const D1_AT = sum('DNE2', 'DNE1', 'DN1');

  test('a train approaching a forced signal brakes and stops short of it, and never passes', () => {
    const w = world(force(routed(), 'D1'));
    let maxFront = 0;
    let decel = 0;
    let prev = 0;
    run(w, (x) => x.time > 400, 400, (x) => {
      maxFront = Math.max(maxFront, x.train.frontM);
      if (x.train.speedMs > 0) decel = Math.max(decel, (prev - x.train.speedMs) / 0.05);
      prev = x.train.speedMs;
    });
    assert.ok(maxFront < D1_AT, `front ${maxFront} stays short of D1 at ${D1_AT}`);
    assert.ok(maxFront > D1_AT - 30);
    assert.equal(w.train.state, 'stopped');
    assert.match(w.train.holdReason, /signal D1/);
    assert.ok(decel <= 0.9 * 1.4, `smooth braking (${decel.toFixed(2)} m/s²)`);
    assert.ok(!w.events.some((e) => e.kind === 'protection-stop'));
    assert.ok(!w.events.some((e) => e.kind === 'passed-signal' && e.signal === 'D1'));
  });

  test('removing the override lets the train go on and complete its journey; automatic logic resumes', () => {
    const w = world(force(routed(), 'D1'));
    run(w, (x) => x.train.state === 'stopped');
    assert.equal(w.train.state, 'stopped');
    const before = w.train.frontM;
    w.sig = release(w.sig, 'D1');
    assert.equal(asp(w.sig)['D1'] === 'red', false, 'D1 shows its normal permissive aspect again');
    run(w, (x) => x.train.finished);
    assert.equal(w.train.finished, true);
    assert.ok(w.train.frontM > before);
    assert.equal(w.train.exited, 'W-OUT');
  });

  test('forcing a signal in the train’s path while it is still approaching: it stops; releasing resumes', () => {
    const w = world(routed());
    run(w, (x) => x.train.speedMs > 20);
    w.sig = force(w.sig, 'D4'); // far ahead
    let maxFront = 0;
    run(w, (x) => x.train.state === 'stopped', 400, (x) => (maxFront = Math.max(maxFront, x.train.frontM)));
    const d4End = D4_END;
    assert.ok(maxFront < d4End, 'never reaches D4');
    assert.match(w.train.holdReason, /D4/);
    w.sig = release(w.sig, 'D4');
    run(w, (x) => x.train.finished);
    assert.equal(w.train.finished, true);
  });

  test('a signal forced to Danger AFTER the train has passed it does not touch the train', () => {
    // two identical runs; in one, D1 is forced as soon as the front is past it
    const a = world(routed());
    const b = world(routed());
    run(a, (x) => x.train.frontM > D1_AT + 20);
    run(b, (x) => x.train.frontM > D1_AT + 20);
    assert.deepEqual(a.train, b.train);
    const occBefore = JSON.stringify(b.sig.network.sectionOccupancy);
    b.sig = force(b.sig, 'D1');
    assert.equal(JSON.stringify(b.sig.network.sectionOccupancy), occBefore, 'occupancy is not modified');
    assert.deepEqual(b.sig.routes, a.sig.routes, 'no route released');
    assert.deepEqual(b.sig.pointLocks, a.sig.pointLocks, 'no point lock released');
    assert.deepEqual(b.sig.sectionLocks, a.sig.sectionLocks);
    // run both on for the rest of the journey: the train behaves identically
    run(a, (x) => x.train.finished);
    run(b, (x) => x.train.finished);
    assert.equal(b.train.finished, true);
    assert.equal(a.train.frontM, b.train.frontM);
    assert.equal(a.time, b.time);
  });

  test('forced too close to stop smoothly: emergency braking, a hard stop short of the signal, never past it', () => {
    const w = world(routed());
    run(w, (x) => x.train.speedMs >= 29.9 && x.train.frontM > D1_AT + 600); // cruising at line speed well beyond D1
    // force a signal 50 m ahead on the line: D2 is manual, so use D4's neighbour DW1 — instead approach D4 closely
    const d4End = D4_END;
    run(w, (x) => x.train.frontM > d4End - 60);
    w.sig = force(w.sig, 'D4');
    let maxFront = 0;
    run(w, (x) => x.train.speedMs === 0 && x.time > 1, 100, (x) => (maxFront = Math.max(maxFront, x.train.frontM)));
    assert.ok(maxFront < d4End, `front ${maxFront} never reached D4 at ${d4End}`);
    assert.equal(w.train.speedMs, 0);
  });

  test('the override does not change the train’s occupancy while it is stopped at the forced signal', () => {
    const w = world(force(routed(), 'D1'));
    run(w, (x) => x.train.state === 'stopped');
    const occ = JSON.stringify(w.sig.network.sectionOccupancy);
    const routes = JSON.stringify(w.sig.routes);
    w.sig = release(w.sig, 'D1');
    w.sig = force(w.sig, 'D1');
    assert.equal(JSON.stringify(w.sig.network.sectionOccupancy), occ);
    assert.equal(JSON.stringify(w.sig.routes), routes);
  });
});
