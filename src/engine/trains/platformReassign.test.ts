/**
 * Phase 8.5: the timetable's platform is a PLAN. The route the signaller sets decides the platform actually used,
 * provided the interlocking and the platform allow it. Scheduled and actual platforms are recorded separately.
 *
 * The "signaller" is calls to requestRoute / validateRouteForTrains; nothing here bypasses the interlocking.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ashcombeDefinition,
  buildNetwork,
  cancelRoute,
  checkLockInvariants,
  createSignallingContext,
  createSignallingState,
  createTrain,
  frontSection,
  requestRoute,
  setTestOccupancy,
  stepFleet,
  validateRouteForTrains,
  type NetworkDef,
  type SignallingContext,
  type SignallingState,
  type Train,
  type TrainRequest,
} from '../index';

const DT = 0.05;
const REAL = createSignallingContext(buildNetwork(ashcombeDefinition));

interface World {
  ctx: SignallingContext;
  sig: SignallingState;
  trains: Train[];
  time: number;
  events: string[];
}
const world = (ctx: SignallingContext = REAL): World => ({ ctx, sig: createSignallingState(ctx.net), trains: [], time: 0, events: [] });

const EAST = (hc: string, extra: Partial<TrainRequest> = {}): TrainRequest => ({ headcode: hc, trainClass: 2, origin: 'W-IN', destination: 'N-OUT', platform: 'PLAT1', dwellS: 20, ...extra });

function add(w: World, req: TrainRequest): void {
  const r = createTrain(w.ctx, w.sig, w.trains, req, 'T1');
  assert.ok(r.ok, r.ok ? '' : r.reason);
  w.sig = r.sig;
  w.trains.push({ ...r.train, started: true });
}
const train = (w: World): Train => w.trains[0] as Train;
function tick(w: World): void {
  const r = stepFleet(w.ctx, w.sig, w.trains, DT);
  w.sig = r.sig;
  w.trains = [...r.trains];
  w.time += DT;
  for (const e of r.events) w.events.push(`${e.kind}: ${e.text}`);
}
function run(w: World, until: (w: World) => boolean, maxS = 600): void {
  for (let t = 0; t < maxS && !until(w); t += DT) {
    tick(w);
    assert.deepEqual(checkLockInvariants(w.ctx, w.sig), [], `lock invariants at ${w.time.toFixed(1)} s`);
  }
}
const route = (w: World, from: string, to: string): void => {
  const r = requestRoute(w.ctx, w.sig, from, to);
  assert.ok(r.ok, r.ok ? '' : r.rejection.message);
  w.sig = r.state;
};
/** The eastbound train is held at U3 (route U2>U3 set), able to go straight on or through the crossover to Platform 2. */
function heldAtU3(w: World): void {
  route(w, 'U2', 'U3');
  run(w, (x) => train(x).limit?.subject === 'U3' && train(x).speedMs < 0.05, 400);
  assert.equal(train(w).limit?.subject, 'U3', 'the train is held at U3');
}

describe('platform reassignment', () => {
  test('A: planned for Platform 1, Platform 1 is unavailable: the signaller sends it to Platform 2 and it stops there', () => {
    const w = world();
    add(w, EAST('2A01'));
    assert.equal(train(w).stop?.platform, 'PLAT1');
    assert.equal(train(w).stop?.scheduledPlatform, 'PLAT1');
    w.sig = setTestOccupancy(w.sig, 'P1', true); // Platform 1 is unavailable
    heldAtU3(w);
    assert.equal(validateRouteForTrains(w.ctx, w.sig, w.trains, 'U4>P1E')?.code, 'SECTION_OCCUPIED');
    assert.equal(validateRouteForTrains(w.ctx, w.sig, w.trains, 'U3>P2E'), null, 'the alternative is allowed');
    route(w, 'U3', 'P2E');
    run(w, (x) => train(x).stop?.phase === 'dwelling', 400);
    const t = train(w);
    assert.equal(t.stop?.phase, 'dwelling');
    assert.equal(frontSection(t), 'P2');
    assert.equal(t.stop?.platform, 'PLAT2', 'actual platform');
    assert.equal(t.stop?.scheduledPlatform, 'PLAT1', 'the plan is kept');
    assert.ok(w.events.some((e) => e.startsWith('platform-changed') && /Platform 2 instead of Platform 1/.test(e)), w.events.join('\n'));
  });

  test('E: the train then dwells, departs by a valid onward route and leaves; the plan is still recorded', () => {
    const w = world();
    add(w, EAST('2A01', { dwellS: 15 }));
    w.sig = setTestOccupancy(w.sig, 'P1', true);
    heldAtU3(w);
    route(w, 'U3', 'P2E');
    run(w, (x) => train(x).stop?.phase === 'done', 400);
    assert.equal(train(w).status, 'ready to depart');
    // the onward route from Platform 2 (set as the train becomes ready)
    const onward = w.ctx.from('P2E').find((r) => r.toKind === 'signal' && w.ctx.net.signals.get(r.to)?.type !== 'shunting');
    assert.ok(onward);
    route(w, 'P2E', onward.to);
    for (let i = 0; i < 20 * 600 && !train(w).finished; i++) {
      tick(w);
      for (const m of w.ctx.routes) {
        if (m.from === 'P2E' || w.ctx.net.signals.get(m.from)?.type !== 'manual' || w.sig.routes[m.from] || !train(w).limit || train(w).limit?.subject !== m.from) continue;
        const r = requestRoute(w.ctx, w.sig, m.from, m.to, m.id);
        if (r.ok) w.sig = r.state;
      }
    }
    const t = train(w);
    assert.ok(t.finished, 'the train completed its journey');
    assert.equal(t.exited, 'N-OUT');
    assert.equal(t.stop?.platform, 'PLAT2');
    assert.equal(t.stop?.scheduledPlatform, 'PLAT1');
    assert.equal(t.stop?.phase, 'departed');
    assert.ok(w.events.some((e) => e.startsWith('arrived')) && w.events.some((e) => e.startsWith('departed')));
    assert.deepEqual(w.sig.sectionLocks, {}, 'everything released afterwards');
  });

  test('without any reassignment the train stops at its planned platform and plan and actual agree', () => {
    const w = world();
    add(w, EAST('2A01'));
    route(w, 'U2', 'U3');
    route(w, 'U3', 'U4');
    route(w, 'U4', 'P1E');
    run(w, (x) => train(x).stop?.phase === 'dwelling', 500);
    assert.equal(frontSection(train(w)), 'P1');
    assert.equal(train(w).stop?.platform, 'PLAT1');
    assert.equal(train(w).stop?.scheduledPlatform, 'PLAT1');
    assert.ok(!w.events.some((e) => e.startsWith('platform-changed')));
  });

  test('a train planned for Platform 2 can equally be sent to Platform 1', () => {
    const w = world();
    add(w, EAST('2A01', { platform: 'PLAT2' }));
    route(w, 'U2', 'U3');
    route(w, 'U3', 'U4');
    route(w, 'U4', 'P1E');
    run(w, (x) => train(x).stop?.phase === 'dwelling', 500);
    assert.equal(frontSection(train(w)), 'P1');
    assert.equal(train(w).stop?.platform, 'PLAT1');
    assert.equal(train(w).stop?.scheduledPlatform, 'PLAT2');
  });

  test('C: Platform 2 is occupied: the alternative route is refused', () => {
    const w = world();
    add(w, EAST('2A01'));
    heldAtU3(w);
    w.sig = setTestOccupancy(w.sig, 'P2', true);
    const r = validateRouteForTrains(w.ctx, w.sig, w.trains, 'U3>P2E');
    assert.equal(r?.code, 'SECTION_OCCUPIED');
    const set = requestRoute(w.ctx, w.sig, 'U3', 'P2E');
    assert.ok(!set.ok, 'and the interlocking itself also refuses it');
  });

  test('D: Platform 2 is free but conflicts with a locked route: refused until the conflict is resolved', () => {
    const w = world();
    add(w, EAST('2A01'));
    heldAtU3(w);
    route(w, 'D2', 'P2W'); // a westbound movement into Platform 2 locks it
    const r = validateRouteForTrains(w.ctx, w.sig, w.trains, 'U3>P2E');
    assert.ok(r, 'refused');
    assert.match(r.message, /conflicting route|reserved|occupied|locked/);
    const cancelled = cancelRoute(w.ctx, w.sig, 'D2>P2W');
    assert.ok(cancelled.ok);
    w.sig = cancelled.state;
    assert.equal(validateRouteForTrains(w.ctx, w.sig, w.trains, 'U3>P2E'), null, 'allowed once the conflict is gone');
  });

  test('B: a platform too short for the train is refused for that train (and only that platform)', () => {
    // A copy of the network with a short Platform 2 (40 m): the real layout is not changed.
    const def: NetworkDef = { ...ashcombeDefinition, sections: ashcombeDefinition.sections.map((s) => (s.id === 'P2' ? { ...s, lengthM: 40 } : s)) };
    const ctx = createSignallingContext(buildNetwork(def));
    const w = world(ctx);
    add(w, EAST('2A01'));
    assert.ok(train(w).spec.lengthM > 40, `the train is ${train(w).spec.lengthM} m`);
    heldAtU3(w);
    const r = validateRouteForTrains(ctx, w.sig, w.trains, 'U3>P2E');
    assert.equal(r?.code, 'PLATFORM_UNSUITABLE');
    assert.match(r?.message ?? '', /too short/);
    assert.equal(validateRouteForTrains(ctx, w.sig, w.trains, 'U4>P1E'), null, 'Platform 1 is still fine');
    assert.equal(validateRouteForTrains(ctx, w.sig, w.trains, 'U3>U4'), null, 'and so is the main line');
  });

  test('a route that has no train for it is not refused for the timetable (routes can be set in advance)', () => {
    const w = world();
    assert.equal(validateRouteForTrains(w.ctx, w.sig, [], 'U3>P2E'), null);
  });

  test('the planned platform is not used if the train has been routed away through the main line', () => {
    const w = world();
    add(w, EAST('2A01'));
    for (const [a, b] of [['U2', 'U3'], ['U3', 'U4'], ['U4', 'U5'], ['U5', 'U6']] as const) route(w, a, b);
    run(w, (x) => x.trains.every((t) => t.finished), 600);
    assert.ok(train(w).finished);
    assert.equal(train(w).stop?.phase, 'pending', 'it never stopped');
    assert.equal(train(w).stop?.platform, 'PLAT1');
  });
});
