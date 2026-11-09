import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ashcombeDefinition,
  buildNetwork,
  cancelRoute,
  cancelRouteFrom,
  checkLockInvariants,
  computeAspects,
  createSignallingContext,
  createSignallingState,
  establishRoute,
  explainAspect,
  isRouteProven,
  lockRoute,
  movePoint,
  requestRoute,
  setTestOccupancy,
  validateRoute,
  type Aspect,
  type SignallingState,
} from '../index';

const net = buildNetwork(ashcombeDefinition);
const ctx = createSignallingContext(net);
const fresh = (): SignallingState => createSignallingState(net);
const aspects = (s: SignallingState) => computeAspects(ctx, s);

/** Request a route and fail the test if it is refused. */
function set(state: SignallingState, from: string, to: string): SignallingState {
  const r = requestRoute(ctx, state, from, to);
  assert.ok(r.ok, r.ok ? '' : `expected ${from}>${to} to be set but: ${r.rejection.message}`);
  return r.state;
}
const occupy = (s: SignallingState, id: string, on = true) => setTestOccupancy(s, id, on);
const pos = (s: SignallingState, p: string) => s.network.pointPositions[p];

describe('signal types come from the Phase 1 network', () => {
  const manual = ['U2', 'U3', 'U4', 'U5', 'P1E', 'P2E', 'P2W', 'D2', 'D3', 'DR1', 'M1'];
  const automatic = ['U1', 'U6', 'D1', 'D4', 'M2', 'UW2', 'UW1', 'UE1', 'DE2', 'DE1', 'DW1', 'DW2', 'MW3', 'MW2', 'MW1', 'MX1', 'MX2'];

  test('there are 28 signals: 11 manual and 17 automatic (U5 became manual in Phase 5: it guards PE1)', () => {
    assert.equal(net.signals.size, 28);
    assert.deepEqual([...net.signals.values()].filter((s) => s.type === 'manual').map((s) => s.id).sort(), [...manual].sort());
    assert.deepEqual([...net.signals.values()].filter((s) => s.type === 'automatic').map((s) => s.id).sort(), [...automatic].sort());
  });

  test('every signal gets an aspect from the central calculation', () => {
    assert.deepEqual(Object.keys(aspects(fresh())).sort(), [...net.signals.keys()].sort());
  });

  test('every automatic signal protects exactly one movement', () => {
    for (const id of automatic) assert.equal(ctx.from(id).length, 1, id);
  });
});

describe('signal aspects', () => {
  test('with nothing set: every manual signal is Red', () => {
    const a = aspects(fresh());
    for (const s of net.signals.values()) if (s.type === 'manual') assert.equal(a[s.id], 'red', s.id);
  });

  test('with nothing set: automatic signals follow what is ahead of them', () => {
    const a = aspects(fresh());
    assert.equal(a['U1'], 'yellow', 'U1 sees Red at U2');
    assert.equal(a['D1'], 'yellow', 'D1 sees Red at D2');
    assert.equal(a['U6'], 'green', 'U6 leads to the clear exit');
    assert.equal(a['U5'], 'red', 'U5 is manual: Red until a route is set');
    assert.equal(a['D4'], 'green');
    assert.equal(a['M2'], 'green');
  });

  test('the four-aspect progression: Red, Single Yellow, Double Yellow, Green', () => {
    let s = fresh();
    s = set(s, 'U2', 'U3'); // U3 is Red ahead of U2
    let a = aspects(s);
    assert.deepEqual([a['U3'], a['U2'], a['U1']], ['red', 'yellow', 'double-yellow']);

    s = set(s, 'U3', 'U4'); // U4 Red ahead of U3
    a = aspects(s);
    assert.deepEqual([a['U4'], a['U3'], a['U2'], a['U1']], ['red', 'yellow', 'double-yellow', 'green']);

    s = set(s, 'U4', 'U5'); // U5 is Red ahead of U4 (manual, no route yet)
    a = aspects(s);
    assert.deepEqual([a['U4'], a['U3'], a['U2'], a['U1']], ['yellow', 'double-yellow', 'green', 'green']);

    s = set(s, 'U5', 'U6'); // U6 is Green, so U5 and everything behind it is Green
    a = aspects(s);
    assert.deepEqual([a['U5'], a['U4'], a['U3'], a['U2'], a['U1']], ['green', 'green', 'green', 'green', 'green']);
  });

  test('aspects update when section occupancy changes', () => {
    let s = set(fresh(), 'U2', 'U3');
    assert.notEqual(aspects(s)['U2'], 'red');
    s = occupy(s, 'UP4');
    assert.equal(aspects(s)['U2'], 'red', 'occupied section ahead of a manual signal');
    assert.equal(aspects(s)['U1'], 'yellow', 'the signal behind steps down');
    s = occupy(s, 'UP4', false);
    assert.equal(aspects(s)['U2'], 'yellow', 'clear again');
  });

  test('automatic signals respond to occupancy of their own section ahead', () => {
    let s = fresh();
    assert.equal(aspects(s)['U6'], 'green');
    s = occupy(s, 'UP12');
    assert.equal(aspects(s)['U6'], 'red');
    assert.equal(aspects(s)['U5'], 'red', 'U5 is manual and has no route');
    s = occupy(s, 'UP12', false);
    assert.equal(aspects(s)['U6'], 'green');
  });

  test('an established route does not clear its signal while a point is out of position', () => {
    let s = set(fresh(), 'M1', 'U3');
    assert.notEqual(aspects(s)['M1'], 'red');
    // simulate a point that has been forced out of position underneath the route
    s = { ...s, network: { ...s.network, pointPositions: { ...s.network.pointPositions, BJ: 'normal' } } };
    assert.equal(aspects(s)['M1'], 'red');
  });

  test('automatic signals cannot have routes set from them', () => {
    const r = requestRoute(ctx, fresh(), 'U1', 'U2');
    assert.ok(!r.ok);
    assert.equal(r.rejection.code, 'NOT_MANUAL');
  });

  test('aspects are a pure function of the state', () => {
    const s = set(fresh(), 'U2', 'U3');
    assert.deepEqual(aspects(s), aspects(s));
    assert.deepEqual(aspects(fresh()), aspects(fresh()));
  });
});

describe('route setting', () => {
  test('a valid route is established, reserves its sections and clears its signal', () => {
    const r = requestRoute(ctx, fresh(), 'U2', 'U3');
    assert.ok(r.ok);
    assert.equal(r.state.routes['U2'], 'U2>U3');
    assert.deepEqual(Object.keys(r.state.sectionLocks).sort(), ['UP3', 'UP4']);
    assert.notEqual(aspects(r.state)['U2'], 'red');
    assert.deepEqual(checkLockInvariants(ctx, r.state), []);
  });

  test('required points move to the correct positions', () => {
    const s = set(fresh(), 'U3', 'P2E');
    assert.equal(pos(s, 'WXU'), 'reverse');
    assert.equal(pos(s, 'WXD'), 'reverse');
    assert.equal(pos(s, 'PW2'), 'reverse');
  });

  test('required points become locked, and only the required points', () => {
    const s = set(fresh(), 'M1', 'U3');
    assert.deepEqual(s.pointLocks, { BJ: 'M1>U3', UJ: 'M1>U3' });
    assert.equal(pos(s, 'BJ'), 'reverse');
    assert.equal(pos(s, 'UJ'), 'reverse');
    assert.equal(pos(s, 'DJ'), 'normal');
  });

  test('required track sections become reserved', () => {
    const s = set(fresh(), 'M1', 'U3');
    assert.deepEqual(Object.keys(s.sectionLocks).sort(), ['BR2', 'LB1', 'LB2', 'LBX', 'UP4']);
    for (const owner of Object.values(s.sectionLocks)) assert.equal(owner, 'M1>U3');
  });

  test('the response says which points were moved', () => {
    const r = requestRoute(ctx, fresh(), 'U4', 'P1E');
    assert.ok(r.ok);
    assert.deepEqual(r.pointsMoved, ['PW1']);
    assert.match(r.message, /PW1 R/);
  });

  test('an invalid movement is rejected, naming both signals', () => {
    const r = requestRoute(ctx, fresh(), 'U2', 'D3');
    assert.ok(!r.ok);
    assert.equal(r.rejection.code, 'NO_SUCH_MOVEMENT');
    assert.match(r.rejection.message, /U2/);
    assert.match(r.rejection.message, /D3/);
  });

  test('a request from something that is not a signal is rejected', () => {
    const r = requestRoute(ctx, fresh(), 'NOPE', 'U3');
    assert.ok(!r.ok);
    assert.equal(r.rejection.code, 'NO_SUCH_MOVEMENT');
  });

  test('an occupied section prevents route establishment, and says which', () => {
    const s = occupy(fresh(), 'UP8');
    const r = requestRoute(ctx, s, 'U4', 'U5');
    assert.ok(!r.ok);
    assert.equal(r.rejection.code, 'SECTION_OCCUPIED');
    assert.equal(r.rejection.subject, 'UP8');
    assert.match(r.rejection.message, /section UP8 is occupied/);
  });

  test('a route whose signal already has a route is refused', () => {
    const s = set(fresh(), 'U3', 'U4');
    const r = requestRoute(ctx, s, 'U3', 'DR1');
    assert.ok(!r.ok);
    assert.equal(r.rejection.code, 'ALREADY_SET');
  });

  test('a route over reserved sections is rejected as conflicting', () => {
    const s = set(fresh(), 'P1E', 'U6'); // reserves UP11
    const r = requestRoute(ctx, s, 'DR1', 'U6'); // also needs UP11
    assert.ok(!r.ok);
    assert.equal(r.rejection.code, 'SECTION_LOCKED');
    assert.equal(r.rejection.owner, 'P1E>U6');
    assert.match(r.rejection.message, /conflicting route P1E>U6/);
  });

  test('two routes cannot converge on the same section', () => {
    const s = set(fresh(), 'M1', 'U3');
    const r = requestRoute(ctx, s, 'U2', 'U3'); // both end in UP4
    assert.ok(!r.ok);
    assert.equal(r.rejection.code, 'SECTION_LOCKED');
  });

  test('routes that cross on the diamond conflict', () => {
    const s = set(fresh(), 'M1', 'U3'); // reserves LBX
    const r = requestRoute(ctx, s, 'D3', 'D4'); // needs DX, which LBX crosses
    assert.ok(!r.ok);
    assert.equal(r.rejection.code, 'CROSSING_CONFLICT');
    assert.match(r.rejection.message, /DX/);
  });

  test('the diamond conflict works in the other direction too', () => {
    const s = set(fresh(), 'D3', 'D4');
    const r = requestRoute(ctx, s, 'M1', 'U3');
    assert.ok(!r.ok);
    assert.equal(r.rejection.code, 'CROSSING_CONFLICT');
  });

  test('opposing movements on bi-directional track are refused', () => {
    const s = set(fresh(), 'D3', 'D4'); // westbound over DN6, DN7 ...
    const r = requestRoute(ctx, s, 'DR1', 'U6'); // eastbound from DN6 over DN5 ...
    assert.ok(!r.ok);
    assert.equal(r.rejection.code, 'OPPOSING_MOVEMENT');
    assert.match(r.rejection.message, /opposing movement/);
  });

  test('non-conflicting routes can be set together', () => {
    let s = set(fresh(), 'U2', 'U3');
    s = set(s, 'U4', 'P1E');
    s = set(s, 'D2', 'P2W');
    assert.equal(Object.keys(s.routes).length, 3);
    assert.deepEqual(checkLockInvariants(ctx, s), []);
  });

  test('requesting a specific route by id picks that movement', () => {
    const r = requestRoute(ctx, fresh(), 'U3', 'U4', 'U3>U4');
    assert.ok(r.ok);
    const none = requestRoute(ctx, fresh(), 'U3', 'U4', 'U3>DR1');
    assert.ok(!none.ok);
  });
});

describe('a refused request changes nothing', () => {
  /** Assert that the state is exactly what it was. */
  const unchanged = (before: SignallingState, after: SignallingState) => {
    assert.equal(after, before, 'the very same state object is returned');
    assert.deepEqual(after, structuredClone(before));
  };

  test('blocked by an occupied section at the far end: no point moves and no lock is taken', () => {
    const before = occupy(fresh(), 'LB2'); // M1>U3 would move BJ and UJ, then find LB2 occupied
    const r = requestRoute(ctx, before, 'M1', 'U3');
    assert.ok(!r.ok);
    unchanged(before, r.state);
    assert.equal(pos(r.state, 'BJ'), 'normal');
    assert.equal(pos(r.state, 'UJ'), 'normal');
    assert.deepEqual(r.state.sectionLocks, {});
    assert.deepEqual(r.state.pointLocks, {});
    assert.equal(aspects(r.state)['M1'], 'red');
  });

  test('blocked by a conflicting route: existing routes and locks are untouched', () => {
    const before = set(fresh(), 'P1E', 'U6');
    const r = requestRoute(ctx, before, 'P2E', 'U6');
    assert.ok(!r.ok);
    unchanged(before, r.state);
  });

  test('invalid movement: nothing changes', () => {
    const before = fresh();
    const r = requestRoute(ctx, before, 'U2', 'D3');
    assert.ok(!r.ok);
    unchanged(before, r.state);
  });

  test('every refusal from establishRoute leaves points, locks and routes alone', () => {
    // Block every route in turn by occupying its last section, then try to set it.
    for (const route of ctx.routes) {
      const last = route.sections[route.sections.length - 1];
      if (!last) continue;
      const before = occupy(fresh(), last);
      const r = establishRoute(ctx, before, route.id);
      assert.ok(!r.ok, route.id);
      unchanged(before, r.state);
    }
  });
});

describe('point control', () => {
  test('a free point can be moved', () => {
    const r = movePoint(ctx, fresh(), 'DJ', 'reverse');
    assert.ok(r.ok);
    assert.equal(pos(r.state, 'DJ'), 'reverse');
  });

  test('a point locked by a route cannot be moved', () => {
    const before = set(fresh(), 'U4', 'P1E'); // locks PW1 reverse
    const r = movePoint(ctx, before, 'PW1', 'normal');
    assert.ok(!r.ok);
    assert.equal(r.rejection.code, 'POINT_LOCKED');
    assert.equal(r.rejection.owner, 'U4>P1E');
    assert.equal(r.state, before);
    assert.equal(pos(r.state, 'PW1'), 'reverse');
  });

  test('a point cannot move while its section is occupied', () => {
    const before = occupy(fresh(), 'UP4'); // UP4 is the toe section of UJ
    const r = movePoint(ctx, before, 'UJ', 'reverse');
    assert.ok(!r.ok);
    assert.equal(r.rejection.code, 'POINT_OCCUPIED');
    assert.equal(r.state, before);
    assert.equal(pos(r.state, 'UJ'), 'normal');
  });

  test('a locked point stays locked, and unmoved, whatever other routes are requested', () => {
    let s = set(fresh(), 'M1', 'U3');
    for (const route of ctx.routes) {
      const r = requestRoute(ctx, s, route.from, route.to);
      if (r.ok) s = r.state;
    }
    assert.equal(s.pointLocks['BJ'], 'M1>U3');
    assert.equal(s.pointLocks['UJ'], 'M1>U3');
    assert.equal(pos(s, 'BJ'), 'reverse');
    assert.equal(pos(s, 'UJ'), 'reverse');
  });

  test('point locks are checked on their own, in addition to section locks (defence in depth)', () => {
    const route = ctx.route('U3>U4');
    assert.ok(route);
    // Lock WXU for another route without reserving any section.
    const rogue = ctx.route('U3>DR1');
    assert.ok(rogue);
    const s: SignallingState = { ...fresh(), pointLocks: { WXU: rogue.id } };
    const rej = validateRoute(ctx, s, route.id);
    assert.equal(rej?.code, 'POINT_LOCKED');
    assert.match(rej?.message ?? '', /point WXU is locked by route U3>DR1/);
  });
});

describe('route cancellation and release', () => {
  test('cancelling returns the entrance signal to Red', () => {
    let s = set(fresh(), 'U2', 'U3');
    assert.notEqual(aspects(s)['U2'], 'red');
    const r = cancelRoute(ctx, s, 'U2>U3');
    assert.ok(r.ok);
    s = r.state;
    assert.equal(aspects(s)['U2'], 'red');
    assert.equal(s.routes['U2'], undefined);
    assert.match(r.message, /Signal U2 returns to Red/);
  });

  test('cancelling releases only the locks belonging to that route', () => {
    let s = set(fresh(), 'U2', 'U3');
    s = set(s, 'U4', 'P1E');
    const r = cancelRoute(ctx, s, 'U2>U3');
    assert.ok(r.ok);
    // gone
    assert.equal(r.state.sectionLocks['UP3'], undefined);
    assert.equal(r.state.sectionLocks['UP4'], undefined);
    assert.equal(r.state.pointLocks['UJ'], undefined);
    // untouched
    assert.equal(r.state.routes['U4'], 'U4>P1E');
    assert.equal(r.state.sectionLocks['P1'], 'U4>P1E');
    assert.equal(r.state.pointLocks['PW1'], 'U4>P1E');
    assert.deepEqual(checkLockInvariants(ctx, r.state), []);
    assert.notEqual(aspects(r.state)['U4'], 'red', 'the other route is still clear');
  });

  test('points stay where they were set after release, but are free to move again', () => {
    const s = set(fresh(), 'U4', 'P1E');
    const r = cancelRoute(ctx, s, 'U4>P1E');
    assert.ok(r.ok);
    assert.equal(pos(r.state, 'PW1'), 'reverse');
    const moved = movePoint(ctx, r.state, 'PW1', 'normal');
    assert.ok(moved.ok);
  });

  test('cancellation is refused when a section of the route is occupied', () => {
    const before = occupy(set(fresh(), 'U2', 'U3'), 'UP4');
    const r = cancelRoute(ctx, before, 'U2>U3');
    assert.ok(!r.ok);
    assert.equal(r.rejection.code, 'CANCEL_OCCUPIED');
    assert.equal(r.state, before, 'locks are untouched');
    assert.equal(before.pointLocks['UJ'], 'U2>U3');
  });

  test('cancelling a route that is not established is refused', () => {
    const r = cancelRoute(ctx, fresh(), 'U2>U3');
    assert.ok(!r.ok);
    assert.equal(r.rejection.code, 'NOT_ESTABLISHED');
    assert.ok(!cancelRouteFrom(ctx, fresh(), 'U2').ok);
  });

  test('cancelling by entrance signal works', () => {
    const s = set(fresh(), 'D2', 'P2W');
    const r = cancelRouteFrom(ctx, s, 'D2');
    assert.ok(r.ok);
    assert.deepEqual(r.state.routes, {});
    assert.deepEqual(r.state.sectionLocks, {});
    assert.deepEqual(r.state.pointLocks, {});
  });

  test('a route can be set again after it is cancelled, and a conflicting one can follow', () => {
    let s = set(fresh(), 'P1E', 'U6');
    const blocked = requestRoute(ctx, s, 'DR1', 'U6');
    assert.ok(!blocked.ok);
    const c = cancelRoute(ctx, s, 'P1E>U6');
    assert.ok(c.ok);
    s = set(c.state, 'DR1', 'U6');
    assert.equal(s.routes['DR1'], 'DR1>U6');
  });
});

describe('route proving', () => {
  test('isRouteProven needs the record, the locks, the point positions and clear track', () => {
    const s = set(fresh(), 'U2', 'U3');
    const route = ctx.route('U2>U3');
    assert.ok(route);
    assert.ok(isRouteProven(s, route));
    assert.ok(!isRouteProven(fresh(), route), 'not established');
    assert.ok(!isRouteProven(occupy(s, 'UP3'), route), 'occupied');
    assert.ok(!isRouteProven({ ...s, sectionLocks: {} }, route), 'locks missing');
    assert.ok(isRouteProven(lockRoute(fresh(), route), route), 'locks recorded with points already correct: proven');
  });
});

describe('aspect explanations', () => {
  const why = (s: SignallingState, id: string) => explainAspect(ctx, s, id).reason;

  test('a manual signal with no route says so', () => {
    assert.match(why(fresh(), 'U3'), /No route is set/);
  });

  test('an occupied section is named', () => {
    const s = occupy(set(fresh(), 'U4', 'U5'), 'UP8');
    assert.equal(why(s, 'U4'), 'Section UP8 is occupied.');
    assert.equal(why(occupy(fresh(), 'UP12'), 'U6'), 'Section UP12 is occupied.');
  });

  test('a reservation and a point out of position are named', () => {
    assert.match(why(fresh(), 'U5'), /No route is set/);
    const refused = requestRoute(ctx, set(fresh(), 'P1E', 'U6'), 'U5', 'U6');
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? '' : refused.rejection.message, /UP10|PE1/);
  });

  test('a clear signal names the next signal and its aspect', () => {
    const s = set(fresh(), 'U2', 'U3');
    assert.match(why(s, 'U2'), /Next signal U3 shows Red/);
    assert.match(why(fresh(), 'UE1'), /boundary is clear/);
  });
});

describe('randomised operation sequences never break the interlocking', () => {
  /** Small deterministic PRNG so failures are reproducible. */
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const sectionIds = [...net.sections.keys()];
  const pointIds = [...net.points.keys()];
  const signalIds = [...net.signals.keys()];

  /** Properties that must hold in every reachable state. */
  function checkState(state: SignallingState, label: string): void {
    assert.deepEqual(checkLockInvariants(ctx, state), [], `${label}: lock records match established routes`);

    // No section or point is claimed by two routes, and no two routes cross on the diamond.
    const sectionOwner = new Map<string, string>();
    for (const routeId of Object.values(state.routes)) {
      const route = ctx.route(routeId);
      assert.ok(route, label);
      for (const s of route.sections) {
        assert.ok(!sectionOwner.has(s), `${label}: ${s} is in two routes`);
        sectionOwner.set(s, routeId);
      }
    }
    for (const [s, owner] of sectionOwner) {
      for (const x of ctx.crossings(s)) {
        assert.ok(!sectionOwner.has(x) || sectionOwner.get(x) === owner, `${label}: ${s} and ${x} are reserved by different routes across the diamond`);
      }
    }

    // A locked point is always in the position its route needs.
    for (const [routeId, route] of Object.entries(state.routes).map(([, id]) => [id, ctx.route(id)] as const)) {
      assert.ok(route, label);
      for (const req of route.points) {
        assert.equal(state.pointLocks[req.point], routeId, `${label}: ${req.point} lock`);
        assert.equal(state.network.pointPositions[req.point], req.position, `${label}: locked point ${req.point} is in the wrong position`);
      }
    }

    const a = aspects(state);
    for (const id of signalIds) {
      const aspect: Aspect | undefined = a[id];
      assert.ok(aspect, `${label}: ${id} has an aspect`);
      const signal = net.signals.get(id);
      assert.ok(signal);
      const reason = explainAspect(ctx, state, id, a).reason;
      if (aspect === 'red') {
        assert.notEqual(reason, 'Held at Red by the interlocking.', `${label}: ${id} is Red with no concrete reason`);
        continue;
      }
      assert.match(reason, /^(Route clear|The line ahead)/, `${label}: ${id} explanation`);
      // A signal that is not at Red protects a movement that is clear, correctly set and held.
      const route = signal.type === 'manual' ? ctx.route(state.routes[id] ?? '') : ctx.from(id)[0];
      assert.ok(route, `${label}: ${id} shows ${aspect} with no movement`);
      for (const s of route.sections) assert.ok(!state.network.sectionOccupancy[s], `${label}: ${id} shows ${aspect} but ${s} is occupied`);
      for (const req of route.points) assert.equal(state.network.pointPositions[req.point], req.position, `${label}: ${id} shows ${aspect} but ${req.point} is not in position`);
      if (signal.type === 'manual') assert.ok(isRouteProven(state, route), `${label}: ${id} cleared without a proven route`);
    }
  }

  test('300 random sequences of 80 operations', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = rng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
      let state = fresh();
      for (let step = 0; step < 80; step++) {
        const label = `seed ${seed} step ${step}`;
        const before = state;
        const roll = rand();
        if (roll < 0.4) {
          const route = pick(ctx.routes);
          const r = requestRoute(ctx, state, route.from, route.to);
          if (!r.ok) assert.equal(r.state, before, `${label}: refused request must not change state`);
          state = r.state;
        } else if (roll < 0.6) {
          const established = Object.values(state.routes);
          if (established.length === 0) continue;
          const r = cancelRoute(ctx, state, pick(established));
          if (!r.ok) assert.equal(r.state, before, `${label}: refused cancel must not change state`);
          state = r.state;
        } else if (roll < 0.8) {
          state = setTestOccupancy(state, pick(sectionIds), rand() < 0.5);
        } else {
          const r = movePoint(ctx, state, pick(pointIds), rand() < 0.5 ? 'normal' : 'reverse');
          if (!r.ok) assert.equal(r.state, before, `${label}: refused point move must not change state`);
          state = r.state;
        }
        checkState(state, label);
      }
    }
  });
});


describe('U5 is a manual signal guarding PE1 (Phase 5, Part A)', () => {
  test('it is manual, in the signal definition and in the signal table', () => {
    assert.equal(net.signals.get('U5')?.type, 'manual');
    assert.equal(net.signals.get('U5')?.at.section, 'UP8', 'position unchanged');
    assert.equal(ctx.net.signals.get('U5')?.at.end, 'B');
  });

  test('it stays at Danger with no route, whatever the track ahead looks like', () => {
    assert.equal(aspects(fresh())['U5'], 'red');
    const s = set(set(set(fresh(), 'U2', 'U3'), 'U3', 'U4'), 'U4', 'U5');
    assert.equal(aspects(s)['U5'], 'red', 'a route INTO U5 does not clear U5 itself');
    assert.match(explainAspect(ctx, s, 'U5').reason, /No route is set/);
  });

  test('a valid route clears it, locks PE1 normal and the sections, and cancelling returns it to Danger', () => {
    const r = requestRoute(ctx, fresh(), 'U5', 'U6');
    assert.ok(r.ok, r.ok ? '' : r.rejection.message);
    assert.equal(r.state.routes['U5'], 'U5>U6');
    assert.equal(aspects(r.state)['U5'], 'green');
    assert.equal(pos(r.state, 'PE1'), 'normal');
    assert.equal(r.state.pointLocks['PE1'], 'U5>U6');
    assert.deepEqual(Object.entries(r.state.sectionLocks).filter(([, o]) => o === 'U5>U6').map(([k]) => k).sort(), r.route.sections.slice().sort());
    const c = cancelRoute(ctx, r.state, 'U5>U6');
    assert.ok(c.ok);
    assert.equal(aspects(c.state)['U5'], 'red');
    assert.deepEqual(checkLockInvariants(ctx, c.state), []);
  });

  test('a route that needs PE1 reverse cannot be set through U5 and is not offered from it', () => {
    for (const m of ctx.from('U5')) assert.ok(m.points.every((p) => p.point !== 'PE1' || p.position === 'normal'), m.id);
    assert.equal(requestRoute(ctx, fresh(), 'U5', 'P1E').ok, false, 'no connection U5 to P1E: that is U4>P1E');
  });

  test('it respects conflicts: refused while P1E>U6 holds PE1 reverse and UP10/UP11', () => {
    const base = set(fresh(), 'P1E', 'U6');
    const r = requestRoute(ctx, base, 'U5', 'U6');
    assert.equal(r.ok, false);
    assert.strictEqual(r.state, base, 'a refused request changes nothing');
    // and the reverse order: with U5>U6 set, P1E>U6 is refused and PE1 cannot be moved
    const first = set(fresh(), 'U5', 'U6');
    assert.equal(requestRoute(ctx, first, 'P1E', 'U6').ok, false);
    const mv = movePoint(ctx, first, 'PE1', 'reverse');
    assert.equal(mv.ok, false);
  });

  test('it respects occupancy: refused with the section named; Red again when the section is occupied after setting', () => {
    const occ = occupy(fresh(), 'UP10');
    const r = requestRoute(ctx, occ, 'U5', 'U6');
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.rejection.message, /UP10.*occupied/);
    const set1 = set(fresh(), 'U5', 'U6');
    assert.equal(aspects(set1)['U5'], 'green');
    assert.equal(aspects(occupy(set1, 'UP10'))['U5'], 'red');
  });

  test('PE1 left in reverse is moved to normal by setting the route, if it is free', () => {
    const moved = movePoint(ctx, fresh(), 'PE1', 'reverse');
    assert.ok(moved.ok);
    const r = requestRoute(ctx, moved.state, 'U5', 'U6');
    assert.ok(r.ok);
    assert.equal(pos(r.state, 'PE1'), 'normal');
  });
});
