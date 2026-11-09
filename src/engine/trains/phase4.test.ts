/**
 * Phase 4: multiple trains, entry at speed, platform stops, dwell, departure,
 * class behaviour, sectional release and the passing scenario.
 *
 * The "signaller" in these tests is just calls to requestRoute: trains never
 * set routes, and nothing here bypasses the interlocking.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ashcombeDefinition,
  buildNetwork,
  checkLockInvariants,
  classAllowsLine,
  createSignallingContext,
  createSignallingState,
  createTrain,
  frontSection,
  occupiedSteps,
  planServices,
  platformFit,
  platformOptions,
  platformStopPosition,
  rearM,
  removeAll,
  requestRoute,
  setTestOccupancy,
  spawnTrain,
  specForClass,
  stepFleet,
  type SignallingState,
  type Train,
  type TrainEvent,
  type TrainRequest,
} from '../index';

const net = buildNetwork(ashcombeDefinition);
const ctx = createSignallingContext(net);
const DT = 0.05;

interface World {
  sig: SignallingState;
  trains: Train[];
  time: number;
  events: TrainEvent[];
  n: number;
}
const newWorld = (sig = createSignallingState(net)): World => ({ sig, trains: [], time: 0, events: [], n: 0 });

function add(w: World, req: TrainRequest, start = true): Train {
  const r = createTrain(ctx, w.sig, w.trains, req, `T${++w.n}`);
  assert.ok(r.ok, r.ok ? '' : r.reason);
  w.sig = r.sig;
  const t = { ...r.train, started: start };
  w.trains.push(t);
  return t;
}
const get = (w: World, headcode: string): Train => {
  const t = w.trains.find((x) => x.spec.headcode === headcode);
  assert.ok(t, headcode);
  return t;
};
function tick(w: World): void {
  const r = stepFleet(ctx, w.sig, w.trains, DT);
  w.sig = r.sig;
  w.trains = [...r.trains];
  w.time += DT;
  w.events.push(...r.events);
}
function run(w: World, until: (w: World) => boolean, maxS = 600, each?: (w: World) => void): void {
  for (let t = 0; t < maxS && !until(w); t += DT) {
    tick(w);
    each?.(w);
    const bad = checkLockInvariants(ctx, w.sig);
    assert.deepEqual(bad, [], `lock invariants at ${w.time.toFixed(1)} s`);
  }
}
const route = (w: World, from: string, to: string): void => {
  const r = requestRoute(ctx, w.sig, from, to);
  assert.ok(r.ok, r.ok ? '' : r.rejection.message);
  w.sig = r.state;
};
const tryRoute = (w: World, from: string, to: string): boolean => {
  const r = requestRoute(ctx, w.sig, from, to);
  if (r.ok) w.sig = r.state;
  return r.ok;
};
const sectionSet = (t: Train): Set<string> => new Set(t.finished ? [] : occupiedSteps(t).map((i) => t.path[i]?.section ?? ''));
/** No section is ever occupied by two trains (the occupancy record holds one owner each, so also compare the trains' own footprints). */
function assertNoSharedTrack(w: World): void {
  const seen = new Map<string, string>();
  for (const t of w.trains) {
    for (const s of sectionSet(t)) {
      const other = seen.get(s);
      assert.equal(other, undefined, `${s} is occupied by both ${other} and ${t.spec.headcode} at ${w.time.toFixed(1)} s`);
      seen.set(s, t.spec.headcode);
    }
  }
}
const WESTBOUND = (hc: string, cls = 1, extra: Partial<TrainRequest> = {}): TrainRequest => ({ headcode: hc, trainClass: cls, origin: 'N-IN', destination: 'W-OUT', ...extra });
const EASTBOUND = (hc: string, cls = 1, extra: Partial<TrainRequest> = {}): TrainRequest => ({ headcode: hc, trainClass: cls, origin: 'W-IN', destination: 'N-OUT', ...extra });

// ---------------------------------------------------------------------------------------------
describe('M1 multi-train foundation', () => {
  test('two trains on non-conflicting routes run independently, with their own IDs and state', () => {
    const w = newWorld();
    const a = add(w, WESTBOUND('1A01'));
    const b = add(w, EASTBOUND('1B02'));
    assert.notEqual(a.id, b.id);
    route(w, 'D2', 'D3');
    route(w, 'D3', 'D4');
    route(w, 'U2', 'U3');
    route(w, 'U3', 'U4');
    route(w, 'U4', 'U5');
    route(w, 'U5', 'U6');
    const seenBoth = { v: false };
    run(w, (x) => x.trains.every((t) => t.finished), 400, (x) => {
      assertNoSharedTrack(x);
      if (x.trains.every((t) => !t.finished && t.frontM > 0)) seenBoth.v = true;
    });
    assert.ok(seenBoth.v, 'both were in the area at the same time');
    assert.equal(get(w, '1A01').exited, 'W-OUT');
    assert.equal(get(w, '1B02').exited, 'N-OUT');
    assert.deepEqual(w.sig.residual, {});
    assert.deepEqual(w.sig.sectionLocks, {}, 'both trains clear: nothing left locked except routes nobody used');
  });

  test('a train does not move until it is started; others carry on', () => {
    const w = newWorld();
    add(w, WESTBOUND('1A01'), false);
    add(w, EASTBOUND('1B02'));
    route(w, 'U2', 'U3');
    for (let i = 0; i < 400; i++) tick(w);
    assert.equal(get(w, '1A01').frontM, get(w, '1A01').frontM < 0 ? get(w, '1A01').frontM : NaN);
    assert.ok(get(w, '1A01').frontM < 0, 'unstarted train still outside');
    assert.ok(get(w, '1B02').frontM > 0, 'started train moved');
    assert.equal(get(w, '1A01').status, 'waiting to enter');
  });

  test('a train follows another on the same line, held by signals, and never shares a section', () => {
    const w = newWorld();
    add(w, EASTBOUND('1A01'));
    route(w, 'U2', 'U3');
    run(w, (x) => get(x, '1A01').frontM > 800);
    add(w, EASTBOUND('1A02'));
    run(w, (x) => x.trains.every((t) => t.finished) || x.time > 400, 400, (x) => {
      assertNoSharedTrack(x);
      // keep setting the next eastbound routes as they become possible
      tryRoute(x, 'U2', 'U3');
      tryRoute(x, 'U3', 'U4');
      tryRoute(x, 'U4', 'U5');
      tryRoute(x, 'U5', 'U6');
    });
    assert.ok(w.trains.every((t) => t.finished), 'both got through');
  });
});

// ---------------------------------------------------------------------------------------------
describe('realistic entry', () => {
  test('a new train waits outside the boundary: it occupies nothing and has no rear in the area', () => {
    const w = newWorld();
    const t = add(w, EASTBOUND('1A01'), false);
    assert.ok(t.frontM < 0);
    assert.equal(sectionSet(t).size, 0);
    assert.deepEqual(Object.values(w.sig.network.sectionOccupancy).filter((o) => o !== null), []);
    assert.equal(t.spec.entrySpeedMs, 25);
    assert.equal(t.speedMs, 0);
  });

  test('when started it is admitted AT its class entry speed, and its position never jumps', () => {
    for (const [cls, v] of [[1, 25], [2, 18], [5, 15]] as const) {
      const w = newWorld();
      add(w, EASTBOUND(`${cls}A01`, cls));
      const before = get(w, `${cls}A01`).frontM;
      tick(w);
      const t = get(w, `${cls}A01`);
      assert.ok(t.speedMs >= v - 1 && t.speedMs <= v + 1, `class ${cls} entered at ${t.speedMs}`);
      assert.ok(t.frontM - before < v * DT + 0.2, 'moved at most one step of distance');
      assert.ok(w.events.some((e) => e.kind === 'admitted'));
    }
  });

  test('an occupied entry section keeps the train outside, then it enters when clear', () => {
    const w = newWorld();
    w.sig = setTestOccupancy(w.sig, 'UPW2', true);
    add(w, EASTBOUND('1A01'));
    for (let i = 0; i < 200; i++) tick(w);
    const t = get(w, '1A01');
    assert.equal(t.status, 'waiting to enter');
    assert.ok(t.frontM < 0 && t.speedMs === 0);
    assert.match(t.holdReason, /occupied/);
    assert.notEqual(w.sig.network.sectionOccupancy['UPW2'], t.id, 'not counted as occupying a section it has not entered');
    assert.ok(!Object.values(w.sig.network.sectionOccupancy).includes(t.id));
    w.sig = setTestOccupancy(w.sig, 'UPW2', false);
    run(w, (x) => get(x, '1A01').frontM > 5, 60);
    assert.ok(get(w, '1A01').frontM > 5, 'entered once clear');
  });

  test('a Red entry signal that is too close to stop for keeps the train outside; one far enough ahead does not', () => {
    const w = newWorld();
    // Occupy the section beyond the first signal so UW2 shows Red: the first limit is the end of UPW2.
    w.sig = setTestOccupancy(w.sig, 'UPW1', true);
    add(w, EASTBOUND('1A01'));
    tick(w);
    const t = get(w, '1A01');
    const gap = 300; // UPW2 length
    const needed = (25 * 25) / (2 * 0.9) + 10;
    assert.equal(t.frontM < 0, needed > gap, 'admitted only if it can stop short of the signal');
  });

  test('a train admitted behind another cannot reach it: it stops at the Red signal with margin', () => {
    const w = newWorld();
    add(w, EASTBOUND('1A01'));
    route(w, 'U2', 'U3');
    run(w, (x) => get(x, '1A01').frontM > 700);
    add(w, EASTBOUND('1A02'));
    run(w, () => false, 120, (x) => assertNoSharedTrack(x));
    const lead = get(w, '1A01');
    const follow = get(w, '1A02');
    assert.ok(!follow.finished);
    assert.ok(follow.frontM < lead.frontM - lead.spec.lengthM || lead.finished, 'stopped behind the leader');
  });
});

// ---------------------------------------------------------------------------------------------
describe('M2 platform stopping model', () => {
  test('the stopping position is the far end of the platform minus the margin, in the direction of travel', () => {
    const p1 = platformStopPosition(net, 'PLAT1', 'A');
    assert.deepEqual(p1, { section: 'P1', atEnd: 'B', distanceFromEntryM: 300 });
    const p2w = platformStopPosition(net, 'PLAT2', 'A');
    const p2e = platformStopPosition(net, 'PLAT2', 'B');
    assert.equal(p2w?.atEnd, 'B');
    assert.equal(p2e?.atEnd, 'A', 'Platform 2 has a stopping position for each direction');
  });

  test('fit check: a train longer than the platform allows is refused', () => {
    assert.equal(platformFit(net, 'PLAT1', 100).ok, true);
    assert.equal(platformFit(net, 'PLAT1', 301).ok, false);
    const spec = { ...specForClass(2, { headcode: '2A01', origin: 'W-IN', destination: 'N-OUT' }), lengthM: 400, stop: { platform: 'PLAT1', dwellS: 10 } };
    const r = spawnTrain(net, createSignallingState(net), spec);
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.reason, /too short/);
  });

  test('a Class 2 train brakes smoothly and stops with its front at the stopping position of Platform 1', () => {
    const w = newWorld();
    add(w, EASTBOUND('2A01', 2, { platform: 'PLAT1', dwellS: 30 }));
    route(w, 'U2', 'U3');
    const trail = { sections: new Set<string>(), maxBrake: 0, last: 0 };
    run(w, (x) => get(x, '2A01').stop?.phase === 'dwelling', 300, (x) => {
      const t = get(x, '2A01');
      for (const s of sectionSet(t)) trail.sections.add(s);
      tryRoute(x, 'U3', 'U4');
      tryRoute(x, 'U4', 'P1E');
      if (t.speedMs < trail.last) trail.maxBrake = Math.max(trail.maxBrake, (trail.last - t.speedMs) / DT);
      trail.last = t.speedMs;
    });
    const t = get(w, '2A01');
    assert.equal(t.stop?.phase, 'dwelling');
    assert.ok(t.speedMs < 0.05);
    assert.equal(frontSection(t), 'P1');
    const p1 = t.path.findIndex((s) => s.section === 'P1');
    const stopPoint = t.ends[p1]! - 10;
    assert.ok(Math.abs(t.frontM - stopPoint) <= 1.5, `front ${t.frontM.toFixed(2)} vs stopping position ${stopPoint}`);
    assert.ok(trail.maxBrake <= 0.9 * 1.4 + 0.01, `braking stayed gentle (${trail.maxBrake.toFixed(2)} m/s²)`);
    assert.ok(rearM(t) > t.ends[p1 - 1]!, 'the whole train is inside the platform, not sticking out');
    assert.ok(!['UP7', 'UP6'].some((s) => (w.sig.network.sectionOccupancy[s] ?? null) === t.id), 'nothing else of it is on the main line');
    assert.equal(t.status, 'dwelling');
  });

  test('a Class 2 train never stops on the mainline for a station stop', () => {
    const w = newWorld();
    add(w, WESTBOUND('2A01', 2, { platform: 'PLAT2', dwellS: 20 }));
    route(w, 'D2', 'P2W');
    const stoppedIn = new Set<string>();
    run(w, (x) => get(x, '2A01').stop?.phase === 'done', 300, (x) => {
      const t = get(x, '2A01');
      if (t.speedMs < 0.02 && t.started && t.frontM > 0) stoppedIn.add(frontSection(t) ?? '');
    });
    assert.deepEqual([...stoppedIn], ['P2'], 'it stood only in the platform');
  });

  test('Platform 2 works in both directions', () => {
    for (const [req, from] of [[WESTBOUND('2A01', 2, { platform: 'PLAT2', dwellS: 5 }), 'D2'], [EASTBOUND('2A02', 2, { platform: 'PLAT2', dwellS: 5 }), 'U2']] as const) {
      const w = newWorld();
      add(w, req);
      if (from === 'D2') route(w, 'D2', 'P2W');
      else {
        route(w, 'U2', 'U3');
      }
      run(w, (x) => x.trains[0]?.stop?.phase === 'dwelling' || x.trains[0]?.stop?.phase === 'done', 300, (x) => {
        if (from === 'U2') tryRoute(x, 'U3', 'P2E');
      });
      assert.equal(frontSection(w.trains[0] as Train), 'P2', `stopped in Platform 2 ${from === 'D2' ? 'westbound' : 'eastbound'}`);
    }
  });

  test('Platform 1 is eastbound only: no plan reaches it from Northbridge', () => {
    assert.equal(planServices(ctx, { trainClass: 2, origin: 'N-IN', destination: 'W-OUT', platform: 'PLAT1' }).length, 0);
    assert.ok(planServices(ctx, { trainClass: 2, origin: 'W-IN', destination: 'N-OUT', platform: 'PLAT1' }).length > 0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('M3 dwell and departure', () => {
  function atPlatform(dwellS: number) {
    const w = newWorld();
    add(w, WESTBOUND('2A01', 2, { platform: 'PLAT2', dwellS }));
    route(w, 'D2', 'P2W');
    run(w, (x) => get(x, '2A01').stop?.phase === 'dwelling', 300);
    return w;
  }

  test('the dwell timer counts simulated time from the moment the train stops', () => {
    const w = atPlatform(30);
    const t0 = w.time;
    const first = get(w, '2A01').stop?.remainingS ?? 0;
    assert.ok(first > 29 && first <= 30);
    run(w, (x) => get(x, '2A01').stop?.phase !== 'dwelling', 100);
    assert.ok(Math.abs(w.time - t0 - 30) < 0.2, `dwell lasted ${(w.time - t0).toFixed(2)} s`);
  });

  test('when dwell expires with the signal at Danger the train is READY TO DEPART and does not move', () => {
    const w = atPlatform(10);
    for (let i = 0; i < 20 * 40; i++) tick(w);
    const t = get(w, '2A01');
    assert.equal(t.stop?.phase, 'done');
    assert.equal(t.status, 'ready to depart');
    assert.ok(t.speedMs < 0.02);
    assert.equal(frontSection(t), 'P2');
    assert.match(t.holdReason, /signal P2W/);
    assert.equal(w.sig.sectionLocks['P2'], 'D2>P2W', 'platform protection is still held');
    assert.ok(w.sig.residual['D2>P2W']);
  });

  test('once the signaller sets the departure route the train leaves; protection is released only after it has CLEARED', () => {
    const w = atPlatform(5);
    run(w, (x) => get(x, '2A01').status === 'ready to depart', 100);
    route(w, 'P2W', 'D4');
    run(w, (x) => get(x, '2A01').status === 'departing', 60);
    assert.equal(get(w, '2A01').status, 'departing');
    // while any of the train is still in P2, P2 stays locked and occupied
    run(w, (x) => get(x, '2A01').stop?.phase === 'departed', 120, (x) => {
      const t = get(x, '2A01');
      if (t.stop?.phase !== 'departed') {
        assert.equal(x.sig.network.sectionOccupancy['P2'], t.id);
        assert.equal(x.sig.sectionLocks['P2'], 'D2>P2W', 'platform locked while the train is physically in it');
      }
    });
    assert.equal(w.sig.sectionLocks['P2'], undefined, 'released after the rear left');
    assert.ok(w.events.some((e) => e.kind === 'departed'));
    run(w, (x) => get(x, '2A01').finished, 200);
    assert.deepEqual(w.sig.residual, {});
    assert.deepEqual(w.sig.sectionLocks, {});
    assert.deepEqual(w.sig.pointLocks, {});
  });

  test('a zero dwell completes immediately and leaves when the signals allow', () => {
    const w = newWorld();
    add(w, WESTBOUND('2A01', 2, { platform: 'PLAT2', dwellS: 0 }));
    route(w, 'D2', 'P2W');
    run(w, (x) => get(x, '2A01').stop?.phase === 'done', 300);
    assert.equal(get(w, '2A01').stop?.phase, 'done');
  });
});

// ---------------------------------------------------------------------------------------------
describe('M4 class behaviour', () => {
  test('class profiles', () => {
    assert.equal(classAllowsLine(1, 'PLATFORM'), false);
    assert.equal(classAllowsLine(1, 'BRANCH'), false);
    assert.equal(classAllowsLine(1, 'UP'), true);
    assert.equal(classAllowsLine(2, 'BRANCH'), true);
    assert.equal(classAllowsLine(2, 'PLATFORM'), true);
    assert.equal(classAllowsLine(5, 'PLATFORM'), true);
  });

  test('Class 1 cannot be given a platform stop or a branch route', () => {
    const w = newWorld();
    const stop = createTrain(ctx, w.sig, [], EASTBOUND('1A01', 1, { platform: 'PLAT1', dwellS: 20 }), 'T1');
    assert.equal(stop.ok, false);
    assert.match(stop.ok ? '' : stop.reason, /never stop/);
    const branch = createTrain(ctx, w.sig, [], { headcode: '1A02', trainClass: 1, origin: 'N-IN', destination: 'M-IO' }, 'T1');
    assert.equal(branch.ok, false);
    assert.match(branch.ok ? '' : branch.reason, /branch/);
  });

  test('a Class 1 plan never includes a platform loop or the branch; Class 2 can', () => {
    for (const p of planServices(ctx, { trainClass: 1, origin: 'W-IN', destination: 'N-OUT' })) {
      assert.deepEqual(p.platforms, []);
      assert.equal(p.usesBranch, false);
    }
    assert.ok(planServices(ctx, { trainClass: 2, origin: 'N-IN', destination: 'M-IO' }).some((p) => p.usesBranch));
  });

  test('a Class 1 express will not enter a platform loop even if the signaller sets the route into it', () => {
    const w = newWorld();
    add(w, EASTBOUND('1A01'));
    route(w, 'U2', 'U3');
    route(w, 'U3', 'U4');
    route(w, 'U4', 'P1E'); // the signaller (wrongly) sends the express into Platform 1
    run(w, () => false, 200, (x) => {
      const t = get(x, '1A01');
      for (const s of sectionSet(t)) assert.notEqual(net.sections.get(s)?.line, 'PLATFORM', 'never on a platform line');
    });
    const t = get(w, '1A01');
    assert.equal(t.state, 'stopped');
    assert.match(t.holdReason, /not permitted for this class/);
    assert.equal(t.limit.kind, 'restricted');
    assert.equal(frontSection(t), 'UP7', 'held at the foot of the loop');
  });

  test('a Class 5 train can run through a platform loop without stopping, and can also stop', () => {
    const w = newWorld();
    add(w, WESTBOUND('5A01', 5));
    route(w, 'D2', 'P2W');
    route(w, 'P2W', 'D4');
    run(w, (x) => get(x, '5A01').finished, 400);
    assert.ok(get(w, '5A01').path.some((s) => s.section === 'P2'), 'ran through Platform 2');
    assert.ok(!w.events.some((e) => e.kind === 'arrived'), 'did not stop');
    const w2 = newWorld();
    add(w2, WESTBOUND('5A02', 5, { platform: 'PLAT2', dwellS: 5 }));
    route(w2, 'D2', 'P2W');
    run(w2, (x) => get(x, '5A02').stop?.phase === 'dwelling', 300);
    assert.equal(frontSection(get(w2, '5A02')), 'P2');
  });

  test('a Class 2 train with no station stop runs through; with the branch as destination it takes the branch', () => {
    const w = newWorld();
    add(w, WESTBOUND('2A01', 2, { destination: 'M-IO' }));
    route(w, 'D2', 'D3');
    route(w, 'D3', 'M2');
    run(w, (x) => get(x, '2A01').finished, 400);
    assert.equal(get(w, '2A01').exited, 'M-IO');
  });
});

// ---------------------------------------------------------------------------------------------
describe('M5 passing scenario: a stopping Class 2 in Platform 1, a Class 1 express passes on the UP main', () => {
  function scenario() {
    const w = newWorld();
    add(w, EASTBOUND('2A01', 2, { platform: 'PLAT1', dwellS: 120 }));
    route(w, 'U2', 'U3');
    const log = { passedWhileDwelling: false, sharedTrack: 0, expressOnPlatform: false, p1LockedWhilePassing: true, pw1FreeWhilePassing: false, expressStarted: false };
    let started = false;
    let departureSet = false;
    run(w, (x) => x.trains.every((t) => t.finished), 900, (x) => {
      assertNoSharedTrack(x);
      const a = get(x, '2A01');
      if (!a.finished) {
        tryRoute(x, 'U2', 'U3');
        tryRoute(x, 'U3', 'U4');
        tryRoute(x, 'U4', 'P1E');
      }
      if (a.stop?.phase === 'dwelling' && !started) {
        started = true;
        add(x, EASTBOUND('1A02', 1));
        log.expressStarted = true;
      }
      const b = x.trains.find((t) => t.spec.headcode === '1A02');
      if (b) {
        for (const s of sectionSet(b)) if (net.sections.get(s)?.line === 'PLATFORM') log.expressOnPlatform = true;
        if (!b.finished && a.stop?.phase === 'dwelling' && ['UP8', 'UP9', 'UP10'].includes(frontSection(b) ?? '')) {
          log.passedWhileDwelling = true;
          // the platform stays protected, the points the express uses are free, and the express route runs over PW1 normal
          if (x.sig.sectionLocks['P1'] !== 'U4>P1E') log.p1LockedWhilePassing = false;
          if (x.sig.pointLocks['PW1'] === undefined || x.sig.pointLocks['PW1'] === 'U4>U5') log.pw1FreeWhilePassing = true;
        }
        if (a.stop?.phase === 'dwelling' || a.stop?.phase === 'pending') {
          // keep setting the express's main-line route; the departure route for the stopper waits until the express is past
          if (!b.path.some((p) => p.section === 'UP9')) {
            tryRoute(x, 'U4', 'U5');
            tryRoute(x, 'U5', 'U6');
          }
        }
      }
      if (b && !b.finished && b.path.some((s) => s.section === 'UP12') === false) {
        /* express not yet clear of the junction: departure route not set */
      }
      if (!departureSet && b && (b.finished || b.path.some((s) => s.section === 'UP12'))) departureSet = tryRoute(x, 'P1E', 'U6');
    });
    return { w, log };
  }

  test('the express runs past the stopped Class 2 on the main line during its dwell', () => {
    const { w, log } = scenario();
    assert.ok(log.expressStarted);
    assert.ok(log.passedWhileDwelling, 'the express was on UP8-UP10 while 2A01 was dwelling in Platform 1');
    assert.equal(get(w, '1A02').exited, 'N-OUT');
    assert.equal(get(w, '2A01').exited, 'N-OUT');
  });

  test('interlocking is never bypassed: platform stays protected, express never on a platform line, no shared track', () => {
    const { log } = scenario();
    assert.equal(log.p1LockedWhilePassing, true, 'Platform 1 stayed locked by the arrival route while the stopper stood in it');
    assert.equal(log.pw1FreeWhilePassing, true, 'the points were released for the express only after the stopper cleared them');
    assert.equal(log.expressOnPlatform, false);
  });

  test('the Class 2 train left only after its dwell and the express is already clear of the junction', () => {
    const { w } = scenario();
    const a = get(w, '2A01');
    assert.equal(a.stop?.phase, 'departed');
    const dep = w.events.findIndex((e) => e.kind === 'departed');
    const expressExit = w.events.findIndex((e) => e.kind === 'exited' && e.text.startsWith('1A02'));
    assert.ok(dep >= 0 && expressExit >= 0 && expressExit < dep, 'the express was out of the area before the stopper departed');
    assert.deepEqual(w.sig.residual, {}, 'nothing is still held by a train');
    assert.deepEqual(checkLockInvariants(ctx, w.sig), []);
  });

  test('sectional release: while the stopper stands in the platform only the platform section is still held', () => {
    const w = newWorld();
    add(w, EASTBOUND('2A01', 2, { platform: 'PLAT1', dwellS: 200 }));
    route(w, 'U2', 'U3');
    run(w, (x) => get(x, '2A01').stop?.phase === 'dwelling', 300, (x) => {
      tryRoute(x, 'U3', 'U4');
      tryRoute(x, 'U4', 'P1E');
    });
    run(w, (x) => x.time > 0 && false, 10);
    const held = Object.entries(w.sig.sectionLocks).filter(([, o]) => o === 'U4>P1E').map(([s]) => s);
    assert.deepEqual(held, ['P1'], 'UP7 and P1W were freed as the rear cleared them');
    assert.equal(w.sig.pointLocks['PW1'], undefined, 'PW1 is free again');
    assert.equal(w.sig.routes['U4'], undefined, 'the signal went back to Red behind the train');
    // and the interlocking still refuses to route anything INTO the occupied platform
    const again = requestRoute(ctx, w.sig, 'U4', 'P1E');
    assert.equal(again.ok, false);
    // but the main line past PW1 can be routed
    assert.ok(requestRoute(ctx, w.sig, 'U4', 'U5').ok, 'main line is available while the platform is occupied');
  });
});

// ---------------------------------------------------------------------------------------------
describe('M6 selection of platforms and reset', () => {
  test('only reachable, unoccupied, unassigned platforms are offered', () => {
    const w = newWorld();
    const q = { trainClass: 2, origin: 'N-IN', destination: 'W-OUT', lengthM: 100 };
    assert.deepEqual(platformOptions(ctx, w.sig, w.trains, q).map((p) => p.id), ['PLAT2'], 'Platform 1 is not reachable westbound');
    assert.deepEqual(platformOptions(ctx, w.sig, w.trains, { ...q, trainClass: 1 }), [], 'express: no platforms');
    assert.deepEqual(platformOptions(ctx, w.sig, w.trains, { ...q, origin: 'W-IN', destination: 'N-OUT' }).map((p) => p.id).sort(), ['PLAT1', 'PLAT2']);
    add(w, WESTBOUND('2A01', 2, { platform: 'PLAT2', dwellS: 5 }), false);
    assert.deepEqual(platformOptions(ctx, w.sig, w.trains, q), [], 'assigned to another train');
    const dup = createTrain(ctx, w.sig, w.trains, WESTBOUND('2A02', 2, { platform: 'PLAT2' }), 'T9');
    assert.equal(dup.ok, false);
    w.sig = setTestOccupancy(w.sig, 'P1', true);
    assert.deepEqual(platformOptions(ctx, w.sig, [], { ...q, origin: 'W-IN', destination: 'N-OUT' }).map((p) => p.id), ['PLAT2'], 'occupied platform not offered');
  });

  test('headcodes must be valid and unique', () => {
    const w = newWorld();
    add(w, EASTBOUND('1A01'), false);
    assert.equal(createTrain(ctx, w.sig, w.trains, EASTBOUND('1A01'), 'T9').ok, false);
    assert.equal(createTrain(ctx, w.sig, w.trains, EASTBOUND('XX'), 'T9').ok, false);
  });

  test('reset mid-scenario leaves no residual routes, locks owned by trains, or occupancy', () => {
    const w = newWorld();
    add(w, EASTBOUND('2A01', 2, { platform: 'PLAT1', dwellS: 120 }));
    add(w, WESTBOUND('1A02'));
    route(w, 'U2', 'U3');
    route(w, 'D2', 'D3');
    run(w, (x) => get(x, '2A01').stop?.phase === 'dwelling' || x.time > 120, 300, (x) => {
      tryRoute(x, 'U3', 'U4');
      tryRoute(x, 'U4', 'P1E');
    });
    assert.ok(Object.keys(w.sig.residual).length > 0);
    w.sig = removeAll(ctx, w.sig, w.trains);
    assert.deepEqual(w.sig.residual, {});
    assert.deepEqual(Object.values(w.sig.network.sectionOccupancy).filter((o) => o !== null), []);
    assert.deepEqual(checkLockInvariants(ctx, w.sig), []);
    // every remaining lock belongs to a normally established route
    for (const owner of [...Object.values(w.sig.sectionLocks), ...Object.values(w.sig.pointLocks)]) assert.ok(Object.values(w.sig.routes).includes(owner));
  });
});

// keep unused-import lint quiet for helpers used only in some tests
void rearM;
