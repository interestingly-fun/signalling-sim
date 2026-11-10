import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ashcombeDefinition,
  buildNetwork,
  cancelRoute,
  checkLockInvariants,
  computeAspects,
  createSignallingContext,
  createSignallingState,
  FixedStepClock,
  JOURNEYS,
  lookAhead,
  movePoint,
  nextWithPositions,
  occupiedSteps,
  otherEnd,
  rearM,
  rearSection,
  frontSection,
  requestRoute,
  reviewSetPointPosition,
  setTestOccupancy,
  spawnTrain,
  stepTrain,
  testTrainSpec,
  trainDirection,
  unlockRoute,
  validateCancelWithTrains,
  type Aspect,
  type SignallingState,
  type Train,
  type TrainEvent,
} from '../index';

const net = buildNetwork(ashcombeDefinition);
const ctx = createSignallingContext(net);
const DT = 0.05;
/** Simulated length of a section: the tests take distances from the network, never from the drawing or from remembered numbers. */
const L = (id: string): number => net.sections.get(id)?.lengthM ?? NaN;
/** Metres of the two Northbridge approach sections (DNE2, DNE1) before DN1 on the westbound journey. */
const PRE = L('DNE2') + L('DNE1');

const route = (sig: SignallingState, from: string, to: string): SignallingState => {
  const r = requestRoute(ctx, sig, from, to);
  assert.ok(r.ok, r.ok ? '' : r.rejection.message);
  return r.state;
};
/** Westbound main: D1 and D4 are automatic, so only D2>D3 and D3>D4 need setting. */
const westboundRoutes = (sig = createSignallingState(net)): SignallingState => route(route(sig, 'D2', 'D3'), 'D3', 'D4');
const eastboundRoutes = (sig = createSignallingState(net)): SignallingState => route(route(route(route(sig, 'U2', 'U3'), 'U3', 'U4'), 'U4', 'U5'), 'U5', 'U6');

interface World {
  sig: SignallingState;
  train: Train;
  time: number;
  events: TrainEvent[];
}
function world(sig: SignallingState, journey = JOURNEYS[0], started = true, overrides = {}): World {
  const sp = spawnTrain(net, sig, testTrainSpec(journey, overrides));
  assert.ok(sp.ok, sp.ok ? '' : sp.reason);
  return { sig: sp.sig, train: { ...sp.train, started }, time: 0, events: [] };
}
function step(w: World, dt = DT): void {
  const r = stepTrain(ctx, w.sig, w.train, dt);
  w.sig = r.sig;
  w.train = r.train;
  w.time += dt;
  w.events.push(...r.events);
}
/** Runs until `until` is true or `maxSeconds` pass. Calls `each` after every step. */
function run(w: World, until: (w: World) => boolean, maxSeconds = 400, each?: (w: World) => void, dt = DT): void {
  for (let t = 0; t < maxSeconds && !until(w); t += dt) {
    step(w, dt);
    each?.(w);
  }
}
const sectionsOf = (t: Train) => t.path.map((s) => s.section);
/** Cumulative metres of each path step, computed independently of the train's own bookkeeping. */
function oracleSpans(t: Train): { section: string; start: number; end: number }[] {
  let at = 0;
  return t.path.map((s) => {
    const len = net.sections.get(s.section)?.lengthM ?? 0;
    const span = { section: s.section, start: at, end: at + len };
    at += len;
    return span;
  });
}

describe('creating the test train', () => {
  test('1G42, Class 1 express, on the Northbridge entry section, front at the boundary, rear outside the area', () => {
    const w = world(createSignallingState(net), JOURNEYS[0], false);
    assert.equal(w.train.spec.headcode, '1G42');
    assert.equal(w.train.spec.trainClass, 1);
    assert.equal(w.train.spec.origin, 'N-IN');
    assert.equal(w.train.spec.destination, 'W-OUT');
    assert.deepEqual(w.train.path, [{ section: 'DNE2', enterEnd: 'B' }]);
    assert.equal(w.train.frontM, 0);
    assert.equal(rearM(w.train), -160);
    assert.equal(w.train.speedMs, 0);
    assert.equal(w.train.state, 'ready');
    assert.equal(trainDirection(w.train), 'BA');
    assert.equal(w.sig.network.sectionOccupancy['DNE2'], 'T1');
  });
  test('headcode, length and movement model are configurable', () => {
    const w = world(createSignallingState(net), JOURNEYS[0], false, { headcode: '2X07', lengthM: 80, maxSpeedMs: 20 });
    assert.equal(w.train.spec.headcode, '2X07');
    assert.equal(rearM(w.train), -80);
    assert.equal(w.train.spec.maxSpeedMs, 20);
  });
  test('cannot be created where it cannot enter: not an entry boundary, or entry section occupied', () => {
    const sig = createSignallingState(net);
    assert.equal(spawnTrain(net, sig, testTrainSpec(JOURNEYS[0], { origin: 'W-OUT' })).ok, false);
    assert.equal(spawnTrain(net, setTestOccupancy(sig, 'DNE2', true), testTrainSpec()).ok, false);
  });
  test('does not move until it is started', () => {
    const w = world(westboundRoutes(), JOURNEYS[0], false);
    for (let i = 0; i < 100; i++) step(w);
    assert.equal(w.train.frontM, 0);
    assert.equal(w.train.state, 'ready');
  });
});

describe('movement', () => {
  test('accelerates smoothly from rest at the configured rate and never exceeds the line speed', () => {
    const w = world(westboundRoutes());
    let prev = 0;
    run(w, (x) => x.time >= 10, 10, (x) => {
      assert.ok(x.train.speedMs - prev <= x.train.spec.accelerationMs2 * DT + 1e-9, 'acceleration limited');
      assert.ok(x.train.speedMs >= prev - 1e-9, 'no braking on a clear line');
      prev = x.train.speedMs;
    });
    assert.ok(Math.abs(w.train.speedMs - 0.8 * 10) < 1e-6);
    assert.ok(Math.abs(w.train.frontM - 0.5 * 0.8 * 100) < 1);
    run(w, (x) => x.train.finished, 400, (x) => assert.ok(x.train.speedMs <= x.train.spec.maxSpeedMs + 1e-9));
  });

  test('position only ever moves forward, in small steps: it never jumps or goes back', () => {
    const w = world(westboundRoutes());
    let prev = w.train.frontM;
    run(w, (x) => x.train.finished, 400, (x) => {
      const d = x.train.frontM - prev;
      assert.ok(d >= 0, 'never backwards');
      assert.ok(d <= x.train.spec.maxSpeedMs * DT + 1e-9, `no teleporting (moved ${d})`);
      prev = x.train.frontM;
    });
  });

  test('front and rear are independent: the rear trails the front by exactly the train length', () => {
    const w = world(westboundRoutes());
    run(w, (x) => x.train.finished, 400, (x) => {
      assert.ok(Math.abs(x.train.frontM - rearM(x.train) - 160) < 1e-9);
    });
  });

  test('sections are entered in connected order through the correct ends, the way the topology allows', () => {
    const w = world(westboundRoutes());
    run(w, (x) => x.train.finished);
    assert.deepEqual(sectionsOf(w.train), ['DNE2', 'DNE1', 'DN1', 'DN2', 'DN3', 'DN4', 'DN5', 'DN6', 'DN7', 'DN8', 'DN9', 'DX', 'DN10', 'DN11', 'DNW1', 'DNW2']);
    for (let i = 0; i + 1 < w.train.path.length; i++) {
      const a = w.train.path[i];
      const b = w.train.path[i + 1];
      assert.ok(a && b);
      const next = nextWithPositions(net, { section: a.section, end: otherEnd(a.enterEnd) }, w.sig.network.pointPositions);
      assert.ok(next && next.kind === 'enter' && next.enter.section === b.section && next.enter.end === b.enterEnd, `${a.section} -> ${b.section}`);
    }
  });

  test('direction: westbound DOWN main runs B to A in every section; eastbound UP main runs A to B', () => {
    const w = world(westboundRoutes());
    run(w, (x) => x.train.finished);
    assert.ok(w.train.path.every((s) => s.enterEnd === 'B'), 'every section entered at its east (B) end');
    const e = world(eastboundRoutes(), JOURNEYS[1]);
    run(e, (x) => x.train.finished);
    assert.ok(e.train.path.every((s) => s.enterEnd === 'A'));
    assert.deepEqual(sectionsOf(e.train), ['UPW2', 'UPW1', 'UP1', 'UP2', 'UP3', 'UP4', 'UP5', 'UP6', 'UP7', 'UP8', 'UP9', 'UP10', 'UP11', 'UP12', 'UPE1']);
  });

  test('stays on the mainline: no platform loop, crossover or branch section is ever entered', () => {
    for (const [journey, routes] of [[JOURNEYS[0], westboundRoutes()], [JOURNEYS[1], eastboundRoutes()]] as const) {
      const w = world(routes, journey);
      run(w, (x) => x.train.finished);
      for (const id of sectionsOf(w.train)) {
        const line = net.sections.get(id)?.line;
        assert.ok(line === 'UP' || line === 'DOWN', `${id} is ${line}`);
      }
    }
  });

  test('leaves the area at its destination and everything is then released', () => {
    const w = world(westboundRoutes());
    run(w, (x) => x.train.finished);
    assert.equal(w.train.finished, true);
    assert.equal(w.train.exited, 'W-OUT');
    assert.equal(w.train.state, 'finished');
    assert.ok(w.events.some((e) => e.kind === 'exited' && e.text.includes('destination')));
    assert.deepEqual(w.sig.routes, {});
    assert.deepEqual(w.sig.sectionLocks, {});
    assert.deepEqual(w.sig.pointLocks, {});
    assert.ok(Object.values(w.sig.network.sectionOccupancy).every((o) => o === null));
    assert.deepEqual(checkLockInvariants(ctx, w.sig), []);
  });
});

describe('occupancy follows front and rear', () => {
  test('a section is occupied while ANY part of the train is in it, and released only when the rear has cleared it', () => {
    const w = world(westboundRoutes());
    let sawTwoSections = false;
    run(w, (x) => x.train.finished, 400, (x) => {
      const spans = oracleSpans(x.train);
      const front = x.train.frontM;
      const rear = rearM(x.train);
      let count = 0;
      for (const sp of spans) {
        const overlaps = front >= sp.start && rear < sp.end - 1e-9;
        const occ = x.sig.network.sectionOccupancy[sp.section];
        if (x.train.finished) assert.equal(occ, null);
        else assert.equal(occ, overlaps ? 'T1' : null, `${sp.section} at front ${front.toFixed(1)} rear ${rear.toFixed(1)}`);
        if (overlaps) count++;
      }
      if (count >= 2) sawTwoSections = true;
    });
    assert.ok(sawTwoSections, 'train straddled a boundary at least once');
  });

  test('front and rear sections are reported separately; the rear is outside the area at the start', () => {
    const w = world(westboundRoutes());
    assert.equal(frontSection(w.train), 'DNE2');
    assert.equal(rearSection(w.train), null);
    run(w, (x) => x.train.frontM > L('DNE2') + 1);
    assert.equal(frontSection(w.train), 'DNE1');
    assert.equal(rearSection(w.train), 'DNE2', 'rear (front - 160 m) is still in the long first section');
    run(w, (x) => x.train.frontM > L('DNE2') + 160 + 1);
    assert.equal(rearSection(w.train), 'DNE1');
  });

  test('DNE2 stays occupied until the rear passes its far end, not when the front leaves it', () => {
    const w = world(westboundRoutes());
    run(w, (x) => x.train.frontM > L('DNE2') + 1);
    assert.equal(w.sig.network.sectionOccupancy['DNE2'], 'T1', 'front is in DNE1 but the rear is still in DNE2');
    assert.equal(rearSection(w.train), 'DNE2');
    run(w, (x) => x.train.frontM >= L('DNE2') + 160 + 1);
    assert.equal(w.sig.network.sectionOccupancy['DNE2'], null);
    assert.equal(w.sig.network.sectionOccupancy['DNE1'], 'T1');
  });

  test('test-marker occupancy of other sections is left alone', () => {
    const sig = setTestOccupancy(westboundRoutes(), 'UP5', true);
    const w = world(sig);
    run(w, (x) => x.train.finished);
    assert.equal(w.sig.network.sectionOccupancy['UP5'], 'REVIEW');
  });
});

describe('signals', () => {
  test('stops before a Red signal using the braking curve, with margin, and never passes it', () => {
    // D1 (auto) is clear, D2 has no route: Red. The train must stop in DN2 short of D2.
    const w = world(createSignallingState(net));
    const d2 = PRE + L('DN1') + L('DN2'); // D2 stands at the end of DN2
    let maxFront = 0;
    let maxDecel = 0;
    let prevV = 0;
    run(w, (x) => x.time > 400, 400, (x) => {
      maxFront = Math.max(maxFront, x.train.frontM);
      if (x.train.speedMs > 0) maxDecel = Math.max(maxDecel, (prevV - x.train.speedMs) / DT); // the final partial step to zero is not a braking rate
      prevV = x.train.speedMs;
    });
    assert.ok(maxFront < d2, `front ${maxFront} stayed short of the signal at ${d2}`);
    assert.ok(maxFront > d2 - 30, `stopped close to the margin, not miles away (${maxFront})`);
    assert.equal(w.train.speedMs, 0);
    assert.equal(w.train.state, 'stopped');
    assert.match(w.train.holdReason, /signal D2/);
    assert.ok(maxDecel <= 0.9 * 1.25, `braked at about the service rate (max ${maxDecel.toFixed(2)} m/s²)`);
    assert.ok(!w.events.some((e) => e.kind === 'protection-stop'), 'planned stop, not an emergency one');
    assert.ok(w.events.some((e) => e.kind === 'stopped'));
  });

  test('braking from line speed on a long approach is smooth: speed falls steadily, never rises again', () => {
    const w = world(createSignallingState(net));
    // run until braking begins, then check the speed profile never increases until stopped
    run(w, (x) => x.train.state === 'braking');
    let prev = w.train.speedMs;
    run(w, (x) => x.train.state === 'stopped', 400, (x) => {
      assert.ok(x.train.speedMs <= prev + 1e-9, 'no re-acceleration while braking');
      prev = x.train.speedMs;
    });
    assert.equal(w.train.state, 'stopped');
  });

  test('resumes smoothly when the signal clears, and the rest of the journey completes', () => {
    const w = world(createSignallingState(net));
    run(w, (x) => x.train.state === 'stopped');
    assert.equal(w.train.state, 'stopped');
    const stoppedAt = w.train.frontM;
    // signaller sets the next two routes
    w.sig = westboundRoutes(w.sig);
    let prev = 0;
    let first = true;
    run(w, (x) => x.train.speedMs > 5, 60, (x) => {
      assert.ok(x.train.speedMs - prev <= 0.8 * DT + 1e-9, 'smooth pull-away');
      prev = x.train.speedMs;
      first = false;
    });
    assert.ok(!first && w.train.frontM > stoppedAt);
    assert.ok(w.events.some((e) => e.kind === 'moving'));
    run(w, (x) => x.train.finished);
    assert.equal(w.train.finished, true);
  });

  test('holds at the second signal too, then goes when it is cleared (D3 is Red until D3>D4 is set)', () => {
    const w = world(route(createSignallingState(net), 'D2', 'D3'));
    run(w, (x) => x.train.state === 'stopped' && x.train.frontM > PRE + L('DN1') + L('DN2'));
    assert.match(w.train.holdReason, /signal D3/);
    w.sig = route(w.sig, 'D3', 'D4');
    run(w, (x) => x.train.finished);
    assert.equal(w.train.exited, 'W-OUT');
  });

  test('a signal that turns Red while the train approaches: it brakes smoothly and stops short', () => {
    const w = world(westboundRoutes());
    run(w, (x) => x.train.frontM > PRE + L('DN1') + L('DN2') + L('DN3') + 5 && x.train.speedMs > 15); // in DN4, D3 (end of DN5) ahead, D3>D4 set
    const d3 = PRE + L('DN1') + L('DN2') + L('DN3') + L('DN4') + L('DN5'); // end of DN5
    assert.equal(w.train.path.length >= 3, true);
    const c = cancelRoute(ctx, w.sig, 'D3>D4'); // refused? only if occupied - the train is not on DN6..
    assert.ok(c.ok, c.ok ? '' : c.rejection.message);
    w.sig = c.state;
    assert.equal(computeAspects(ctx, w.sig)['D3'], 'red');
    let maxFront = 0;
    run(w, (x) => x.time > 400 || x.train.state === 'stopped', 400, (x) => (maxFront = Math.max(maxFront, x.train.frontM)));
    assert.equal(w.train.state, 'stopped');
    assert.ok(maxFront < d3, 'stopped short of D3');
    assert.ok(!w.events.some((e) => e.kind === 'protection-stop'));
  });

  test('a signal that turns Red too close to stop: emergency braking and a hard stop, never past the signal', () => {
    const w = world(westboundRoutes());
    const d3 = PRE + L('DN1') + L('DN2') + L('DN3') + L('DN4') + L('DN5');
    run(w, (x) => x.train.speedMs >= 29.9 && x.train.frontM > d3 - 60 - 160); // fast, ~60 m before D3... check below
    // bypass the approach lock on purpose: this is the interlocking being defeated, the train must still be safe
    const r = ctx.route('D3>D4');
    assert.ok(r);
    w.sig = unlockRoute(w.sig, r);
    assert.equal(computeAspects(ctx, w.sig)['D3'], 'red');
    let maxFront = 0;
    run(w, (x) => x.train.speedMs === 0 && x.time > 1, 100, (x) => (maxFront = Math.max(maxFront, x.train.frontM)));
    assert.ok(maxFront < d3, `front ${maxFront} never reached D3 at ${d3}`);
    assert.equal(w.train.speedMs, 0);
  });

  test('large time steps (a slow frame) cannot carry the train past a Red signal', () => {
    for (const dt of [0.05, 0.25, 1, 5, 30]) {
      const w = world(createSignallingState(net));
      let maxFront = 0;
      run(w, (x) => x.time > 400, 400, (x) => (maxFront = Math.max(maxFront, x.train.frontM)), dt);
      assert.ok(maxFront < PRE + L('DN1') + L('DN2'), `dt=${dt}: front ${maxFront} must stay short of D2`);
    }
  });

  test('passing signals are reported, and the train follows only the established route', () => {
    const w = world(westboundRoutes());
    run(w, (x) => x.train.finished);
    const passed = w.events.filter((e) => e.kind === 'passed-signal').map((e) => (e.kind === 'passed-signal' ? e.signal : ''));
    assert.deepEqual(passed, ['DE2', 'DE1', 'D1', 'D2', 'D3', 'D4', 'DW1', 'DW2']);
  });

  test('a route into a platform loop is followed when the signaller sets it (the train never chooses its own way)', () => {
    const r = requestRoute(ctx, createSignallingState(net), 'D2', 'P2W');
    assert.ok(r.ok, r.ok ? '' : r.rejection.message);
    const w = world(r.state, JOURNEYS[0], true, { trainClass: 2 });
    run(w, (x) => x.time > 400 || x.train.state === 'stopped');
    assert.deepEqual(sectionsOf(w.train), ['DNE2', 'DNE1', 'DN1', 'DN2', 'DN3', 'DN4', 'P2E', 'P2'], 'followed the established Platform 2 route and nothing else');
    assert.equal(w.train.state, 'stopped');
    assert.match(w.train.holdReason, /signal P2W/);
  });
});

describe('look-ahead barriers', () => {
  const green = (): Record<string, Aspect> => Object.fromEntries([...net.signals.keys()].map((id) => [id, 'green' as Aspect]));
  const fresh = (): World => world(createSignallingState(net), JOURNEYS[0], false);

  test('a section occupied by something else is a barrier even when the signals show proceed', () => {
    const w = fresh();
    const sig = setTestOccupancy(w.sig, 'DN3', true);
    const lim = lookAhead(net, sig, green(), w.train);
    assert.equal(lim.kind, 'occupied');
    assert.equal(lim.subject, 'DN3');
    assert.equal(lim.limitM, PRE + L('DN1') + L('DN2')); // end of DN2: it will not enter DN3
  });

  test('points not set for the way ahead are a barrier', () => {
    const w = fresh();
    let found: string | undefined;
    for (const p of net.points.values()) {
      for (const pos of ['normal', 'reverse'] as const) {
        const base = createSignallingState(net);
        const sig = { ...base, network: reviewSetPointPosition(base.network, p.id, pos) };
        const lim = lookAhead(net, sig, green(), w.train);
        if (lim.kind === 'points') found = `${p.id} ${pos}`;
      }
    }
    assert.ok(found, 'at least one wrong point position blocks the line ahead');
  });

  test('a facing move follows the points as they are set, so the same scan reports different limits for different settings', () => {
    const w = fresh();
    const base = createSignallingState(net);
    const limits = new Set<string>();
    for (const pos of ['normal', 'reverse'] as const) {
      const sig = { ...base, network: reviewSetPointPosition(base.network, 'PE2', pos) };
      const lim = lookAhead(net, sig, green(), w.train);
      limits.add(`${lim.kind}@${lim.limitM}`);
    }
    assert.equal(limits.size, 2, [...limits].join(' vs '));
  });
});

describe('point and route protection', () => {
  test('points on the route stay locked while the train approaches, runs over and clears them', () => {
    const w = world(westboundRoutes());
    const checked = new Set<string>();
    run(w, (x) => x.train.finished, 400, (x) => {
      if (x.train.finished) return;
      const occupied = new Set(occupiedSteps(x.train).map((i) => x.train.path[i]?.section));
      for (const p of net.points.values()) {
        const touches = [p.toe, p.normal, p.reverse].some((e) => occupied.has(e.section));
        if (!touches) continue;
        checked.add(p.id);
        assert.ok(x.sig.pointLocks[p.id] !== undefined, `point ${p.id} locked while the train is on it (front ${x.train.frontM.toFixed(0)})`);
        const m = movePoint(ctx, x.sig, p.id, x.sig.network.pointPositions[p.id] === 'normal' ? 'reverse' : 'normal');
        assert.equal(m.ok, false, `point ${p.id} cannot be moved under the train`);
      }
    });
    for (const id of ['PE2', 'PW2', 'WXD', 'DJ', 'EXD']) assert.ok(checked.has(id), `${id} was protected`);
  });

  test('the train only ever traverses points set for it: no point changes while it is on or ahead of them on its route', () => {
    const w = world(westboundRoutes());
    const positions = JSON.stringify(w.sig.network.pointPositions);
    run(w, (x) => x.train.finished, 400, (x) => {
      assert.equal(JSON.stringify(x.sig.network.pointPositions), positions);
      const spans = x.train.path;
      for (let i = 0; i + 1 < spans.length; i++) {
        const a = spans[i];
        const b = spans[i + 1];
        if (!a || !b) continue;
        const next = nextWithPositions(net, { section: a.section, end: otherEnd(a.enterEnd) }, x.sig.network.pointPositions);
        assert.ok(next && next.kind === 'enter' && next.enter.section === b.section);
      }
    });
  });

  test('sectional release: each section of a route is freed only after the REAR has cleared it, and the signal returns to Red once passed', () => {
    const w = world(westboundRoutes());
    const r = ctx.route('D2>D3');
    assert.ok(r);
    // cumulative end of each section of the route along the path
    let released = false;
    let everHeld = false;
    run(w, (x) => x.train.finished, 400, (x) => {
      if (x.sig.residual['D2>D3']) everHeld = true;
      const passed = everHeld && !released;
      if (everHeld && !released) assert.equal(x.sig.routes['D2'], undefined, 'D2 went back to Red once the train passed it');
      for (const s of r.sections) {
        const idx = x.train.path.findIndex((p) => p.section === s);
        const clear = idx >= 0 && rearM(x.train) >= x.train.ends[idx]! - 1e-6;
        if (passed) {
          if (clear) assert.equal(x.sig.sectionLocks[s], undefined, `${s} freed once the rear cleared it`);
          else if (idx >= 0 || x.sig.sectionLocks[s] !== undefined) assert.equal(x.sig.sectionLocks[s], 'D2>D3', `${s} stays locked until the rear clears it`);
        }
      }
      if (everHeld && x.sig.residual['D2>D3'] === undefined) released = true;
    });
    assert.ok(released);
    assert.deepEqual(w.sig.residual, {});
  });

  test('the interlocking stays consistent for the whole journey (locks match established routes)', () => {
    const w = world(westboundRoutes());
    run(w, (x) => x.train.finished, 400, (x) => assert.deepEqual(checkLockInvariants(ctx, x.sig), []));
  });

  test('the automatic signals’ movements are locked while the train passes over them', () => {
    const w = world(westboundRoutes());
    run(w, (x) => x.train.frontM > PRE + L('DN1') + 5); // just past D1
    assert.equal(w.sig.sectionLocks['DN2'], 'D1>D2');
    assert.equal(w.sig.residual['D1>D2'], true, 'the passed signal no longer owns the route; it is held as a residual route');
    run(w, (x) => x.train.frontM > PRE + ['DN1', 'DN2', 'DN3', 'DN4', 'DN5', 'DN6', 'DN7', 'DN8', 'DN9', 'DX', 'DN10'].reduce((n, id) => n + L(id), 0) + 5); // beyond D4 (end of DN10)
    assert.equal(w.sig.residual['D4>DW1'], true);
  });

  test('approach locking: a route cannot be cancelled once the train is in its entrance section', () => {
    const w = world(westboundRoutes());
    run(w, (x) => x.train.frontM > PRE + L('DN1') + L('DN2') + L('DN3') + L('DN4') + 5); // in DN5, where D3 stands
    assert.equal(frontSection(w.train), 'DN5');
    const rej = validateCancelWithTrains(ctx, w.sig, [w.train], 'D3>D4');
    assert.ok(rej, 'refused');
    assert.match(rej.message, /approach/);
    // and a route the train is nowhere near is still cancellable
    const w2 = world(westboundRoutes());
    assert.equal(validateCancelWithTrains(ctx, w2.sig, [w2.train], 'D3>D4'), null);
  });

  test('a conflicting route cannot be set over the train: the interlocking refuses it while the train is on the route', () => {
    const w = world(westboundRoutes());
    run(w, (x) => x.train.frontM > PRE + L('DN1') + L('DN2') + L('DN3') + 5); // in DN4
    // Merefield branch route from D3 needs DJ reverse, but DJ is locked and DN... either way it must fail
    const r = ctx.from('D3').find((x) => x.points.some((p) => p.point === 'DJ' && p.position === 'reverse'));
    if (r) {
      const res = requestRoute(ctx, w.sig, 'D3', r.to, r.id);
      assert.equal(res.ok, false);
    }
  });
});

describe('fixed-step simulation', () => {
  test('the clock runs the same number of steps however the time is chopped into frames', () => {
    for (const fps of [20, 30, 60, 75, 144, 240]) {
      const c = new FixedStepClock(DT);
      let steps = 0;
      for (let i = 0; i < fps * 10; i++) steps += c.advance(1 / fps);
      assert.ok(Math.abs(steps - 200) <= 1, `${fps} fps -> ${steps} steps`);
    }
  });

  test('a long pause (hidden tab) is capped, not replayed', () => {
    const c = new FixedStepClock(DT, 0.25);
    assert.equal(c.advance(60), 5);
  });

  test('the train state after N steps is identical whatever the frame rate that produced them', () => {
    const results: string[] = [];
    for (const fps of [24, 60, 144]) {
      const w = world(westboundRoutes());
      const c = new FixedStepClock(DT);
      let done = 0;
      while (done < 800) {
        const n = Math.min(c.advance(1 / fps), 800 - done);
        for (let i = 0; i < n; i++) step(w);
        done += n;
      }
      results.push(JSON.stringify([w.train.frontM, w.train.speedMs, w.train.path.length, w.train.state]));
    }
    assert.equal(results[0], results[1]);
    assert.equal(results[1], results[2]);
  });

  test('alpha is the fraction of a step carried over, for interpolation', () => {
    const c = new FixedStepClock(0.05);
    assert.equal(c.advance(0.075), 1);
    assert.ok(Math.abs(c.alpha - 0.5) < 1e-9);
  });
});
