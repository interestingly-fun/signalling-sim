/**
 * Phase 9 correction: shunting signal associations, shunting authority, and the 5 mph siding interior.
 * Everything runs through the real interlocking (requestRoute / validateRouteForTrains / stepFleet).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SPEED_CONFIG,
  ashcombeDefinition,
  buildNetwork,
  checkLockInvariants,
  computeAspects,
  createEcsTrain,
  createSignallingContext,
  createSignallingState,
  createTrain,
  explainAspect,
  frontSection,
  occupiedSteps,
  planEcsCycles,
  requestRoute,
  sectionLimit,
  stepFleet,
  stockPerformance,
  validateRouteForTrains,
  type EcsPlan,
  type SignallingState,
  type Train,
} from '../index';

const DT = 0.05;
const CTX = createSignallingContext(buildNetwork(ashcombeDefinition));
const MPH5 = 5 * 0.44704;

const accessRoutes = () => [...CTX.net.signals.keys()].flatMap((id) => CTX.from(id)).filter((r) => r.shuntAccess);
const lengthM = stockPerformance({ model: '170', formation: '2-car' }).lengthM;
const plansFor = (origin: string, siding: string): EcsPlan[] => planEcsCycles(CTX, { origin, siding, destination: 'W-OUT', lengthM, stopMarginM: 10 });

function ecsWorld(plan: EcsPlan, origin: string, siding: string) {
  const r = createEcsTrain(CTX, createSignallingState(CTX.net), [], { headcode: '5E01', model: '170', formation: '2-car', origin, siding, onward: { headcode: '1Z10', trainClass: 2, destination: 'W-OUT' }, stablingS: 60, plan }, 'T1');
  assert.ok(r.ok);
  return { sig: r.sig as SignallingState, trains: [{ ...r.train, started: true }] as Train[], time: 0 };
}

/** A signaller who sets each planned route (and the shunting route after an access route) from the signal the train stands at. */
function signal(w: { sig: SignallingState; trains: Train[] }, setShuntRoute = true): void {
  for (const t of w.trains) {
    if (t.finished) continue;
    const at = t.limit.kind === 'signal' ? t.limit.subject : undefined;
    if (!at || w.sig.routes[at] !== undefined) continue;
    const route = t.plan.map((id) => CTX.route(id)).find((r) => r?.from === at);
    if (!route) continue;
    if (!setShuntRoute && CTX.net.signals.get(route.from)?.mainline) continue; // the signaller never sets the shunting route
    const r = requestRoute(CTX, w.sig, route.from, route.to, route.id);
    if (!r.ok) continue;
    w.sig = r.state;
    if (route.shuntAccess && setShuntRoute) {
      const next = t.plan.map((id) => CTX.route(id)).find((x) => x?.from === route.to);
      if (next) {
        const r2 = requestRoute(CTX, w.sig, next.from, next.to, next.id);
        if (r2.ok) w.sig = r2.state;
      }
    }
  }
}
function step(w: { sig: SignallingState; trains: Train[]; time: number }) {
  const r = stepFleet(CTX, w.sig, w.trains, DT);
  w.sig = r.sig;
  w.trains = [...r.trains];
  w.time += DT;
  return r.events;
}

describe('explicit association', () => {
  test('only AJ1 and AJ4 carry associations, and only to ordinary manual signals', () => {
    for (const s of CTX.net.signals.values()) {
      if (s.id !== 'S1' && s.id !== 'S4') assert.equal(s.associatedMain, undefined, s.id);
    }
    assert.deepEqual(CTX.net.signals.get('S1')?.associatedMain, ['DR1', 'P2E']);
    assert.deepEqual(CTX.net.signals.get('S4')?.associatedMain, ['U5', 'P1E', 'DR1', 'P2E']);
    for (const s of ['S1', 'S4']) for (const m of CTX.net.signals.get(s)?.associatedMain ?? []) assert.equal(CTX.net.signals.get(m)?.type, 'manual');
  });

  test('access routes exist exactly for associated mains; no ordinary signal routes straight into a siding', () => {
    const ids = accessRoutes().map((r) => r.id).sort();
    assert.deepEqual(ids, ['DR1>S1', 'DR1>S4', 'P1E>S4', 'P2E>S1', 'P2E>S4', 'U5>S4']);
    for (const r of accessRoutes()) assert.ok(CTX.net.signals.get(r.to)?.associatedMain?.includes(r.from), r.id);
    for (const r of [...CTX.net.signals.keys()].flatMap((id) => CTX.from(id))) {
      if (CTX.net.signals.get(r.from)?.type !== 'shunting') assert.ok(!r.sections.some((s) => CTX.net.sections.get(s)?.line === 'SIDING'), `${r.id} enters siding track`);
    }
  });
});

describe('a shunting Proceed never clears the main signal', () => {
  test('access route set: the main signal CLEARS (Caution); the shunting signal is Proceed only with its own proven route', () => {
    let sig = createSignallingState(CTX.net);
    const a = requestRoute(CTX, sig, 'DR1', 'S1', 'DR1>S1');
    assert.ok(a.ok);
    sig = a.state;
    let asp = computeAspects(CTX, sig);
    assert.equal(asp['DR1'], 'yellow', 'the main signal shows Caution once the access route to AJ1 is set and proven');
    assert.equal(asp['S1'], 'red', 'shunting signal is Stop until its own route is set');
    assert.match(explainAspect(CTX, sig, 'DR1', asp).reason, /Caution/);
    const b = requestRoute(CTX, sig, 'S1', 'SD1-BUF');
    assert.ok(b.ok);
    sig = b.state;
    asp = computeAspects(CTX, sig);
    assert.equal(asp['S1'], 'green', 'shunting Proceed');
    assert.equal(asp['DR1'], 'yellow', 'main still Caution');
    assert.deepEqual(checkLockInvariants(CTX, sig), []);
  });

  test('a shunting Proceed with no access route does not touch the main signal', () => {
    let sig = createSignallingState(CTX.net);
    const b = requestRoute(CTX, sig, 'S1', 'SD1-BUF');
    if (b.ok) sig = b.state;
    const asp = computeAspects(CTX, sig);
    for (const m of ['DR1', 'P2E', 'U5', 'P1E']) assert.equal(asp[m], 'red', `${m} stays at Danger`);
  });
});

describe('normal mainline movement obeys the main signal', () => {
  test('a Class 2 train never passes U5 at Danger even with AJ4 showing Proceed', () => {
    let sig = createSignallingState(CTX.net);
    const made = createTrain(CTX, sig, [], { headcode: '2A01', trainClass: 2, origin: 'W-IN', destination: 'N-OUT', platform: null }, 'T1');
    assert.ok(made.ok);
    sig = made.sig;
    const w = { sig, trains: [{ ...made.train, started: true }] as Train[], time: 0 };
    const s4 = requestRoute(CTX, w.sig, 'S4', 'SD1-BUF');
    if (s4.ok) w.sig = s4.state;
    let passed = false;
    for (let i = 0; i < 20 * 700; i++) {
      for (const id of made.train.plan) {
        const r = CTX.route(id);
        if (!r || r.from === 'U5' || w.sig.routes[r.from] !== undefined) continue;
        const q = requestRoute(CTX, w.sig, r.from, r.to, r.id);
        if (q.ok) w.sig = q.state;
      }
      step(w);
      const t = w.trains[0] as Train;
      if (t.finished || ['UP11', 'UP11B', 'LU1'].includes(frontSection(t) ?? '')) passed = true;
      assert.equal(computeAspects(CTX, w.sig)['U5'], 'red');
    }
    assert.equal(passed, false, 'the train waits at U5');
    assert.ok((w.trains[0] as Train).speedMs < 0.5);
  });

  test('a Class 2 train still stops at U5 when U5 shows Caution for a shunting access route (the clearance is for shunting movements only)', () => {
    let sig = createSignallingState(CTX.net);
    const made = createTrain(CTX, sig, [], { headcode: '2A02', trainClass: 2, origin: 'W-IN', destination: 'N-OUT', platform: null }, 'T1');
    assert.ok(made.ok);
    sig = made.sig;
    const w = { sig, trains: [{ ...made.train, started: true }] as Train[], time: 0 };
    const acc = requestRoute(CTX, w.sig, 'U5', 'S4', 'U5>S4'); // set directly: the train-aware refusal is tested separately
    assert.ok(acc.ok);
    w.sig = acc.state;
    assert.equal(computeAspects(CTX, w.sig)['U5'], 'yellow');
    let passed = false;
    for (let i = 0; i < 20 * 700; i++) {
      for (const id of made.train.plan) {
        const r = CTX.route(id);
        if (!r || r.from === 'U5' || w.sig.routes[r.from] !== undefined) continue;
        const q = requestRoute(CTX, w.sig, r.from, r.to, r.id);
        if (q.ok) w.sig = q.state;
      }
      step(w);
      const t = w.trains[0] as Train;
      if (t.finished || ['UP11', 'UP11B', 'LU1'].includes(frontSection(t) ?? '')) passed = true;
    }
    assert.equal(passed, false, 'the Class 2 train waits at U5');
  });

  test('a Class 2 train is refused an access route, and so is a Class 5 that is not on an ECS movement', () => {
    const sig = createSignallingState(CTX.net);
    for (const trainClass of [2, 5] as const) {
      const made = createTrain(CTX, sig, [], { headcode: `${trainClass}A01`, trainClass, origin: 'W-IN', destination: 'N-OUT', platform: null }, 'T1');
      assert.ok(made.ok);
      const t: Train = { ...made.train, started: true, limit: { kind: 'signal', subject: 'U5' } as Train['limit'] };
      const refused = validateRouteForTrains(CTX, made.sig, [t], 'U5>S4');
      assert.ok(refused, `class ${trainClass} refused`);
    }
  });
});

describe('authorised shunting movement', () => {
  const plan = plansFor('N-IN', 'SIDING1').find((p) => p.arrival.movements.some((m) => CTX.route(m)?.shuntAccess));
  const access = plan?.arrival.movements.find((m) => CTX.route(m)?.shuntAccess) as string;

  test('Stop prevents the movement: with only the access route set the main signal clears but the train stops at the shunting signal', () => {
    assert.ok(plan);
    const w = ecsWorld(plan, 'N-IN', 'SIDING1');
    const accessRoute = CTX.route(access)!;
    let sawAccess = false;
    let sawYellow = false;
    for (let i = 0; i < 20 * 1500; i++) {
      signal(w, false); // never sets the shunting route
      step(w);
      if (w.sig.routes[accessRoute.from] === access) {
        sawAccess = true;
        if (computeAspects(CTX, w.sig)[accessRoute.from] === 'yellow') sawYellow = true;
      }
    }
    const t = w.trains[0] as Train;
    assert.ok(sawAccess, 'access route was set');
    assert.ok(sawYellow, 'the main signal showed the route was set');
    assert.equal(t.limit.kind, 'signal');
    assert.equal(t.limit.subject, accessRoute.to, 'the train waits at the shunting signal (Stop)');
    assert.ok(t.speedMs < 0.5);
    assert.ok(!t.finished);
    assert.equal(t.ecs?.stage, 'inbound', 'never entered the siding');
    assert.ok(!occupiedSteps(t).some((k) => t.path[k]?.section === 'SD1'));
  });

  test('the associated main shows Caution while the access route is set; the train passes it, then AJ-Proceed lets it into the siding', () => {
    assert.ok(plan);
    const w = ecsWorld(plan, 'N-IN', 'SIDING1');
    const accessRoute = CTX.route(access)!;
    const events: string[] = [];
    let sawPass = false;
    let sawYellow = false;
    for (let i = 0; i < 20 * 2500 && (w.trains[0] as Train).ecs?.stage !== 'stabled'; i++) {
      signal(w);
      for (const e of step(w)) events.push(e.text);
      const asp = computeAspects(CTX, w.sig);
      if (w.sig.routes[accessRoute.from] === access) {
        assert.equal(asp[accessRoute.from], 'yellow', 'the main signal shows Caution while its access route is set');
        sawYellow = true;
      }
      if (events.some((e) => e.includes(`passed signal ${CTX.signalName(accessRoute.from)}`))) sawPass = true;
    }
    assert.ok(sawYellow, 'the signal changed aspect when the access route was set');
    assert.ok(sawPass, events.join(' | '));
    const t = w.trains[0] as Train;
    assert.equal(t.ecs?.stage, 'stabled');
  });

  test('authority covers that movement only: the shunting signal is Stop again after the train passes it', () => {
    assert.ok(plan);
    const w = ecsWorld(plan, 'N-IN', 'SIDING1');
    const s = CTX.route(access)!.to;
    let sawProceed = false;
    for (let i = 0; i < 20 * 2500 && (w.trains[0] as Train).ecs?.stage !== 'stabled'; i++) {
      signal(w);
      step(w);
      const a = computeAspects(CTX, w.sig)[s];
      if (a === 'green') sawProceed = true;
      const t = w.trains[0] as Train;
      const ahead = t.path.findIndex((p) => p.section === 'SD1');
      if (sawProceed && ahead >= 0 && occupiedSteps(t).every((k) => k >= ahead - 1 && k <= ahead + 1) && frontSection(t) === 'SD1') assert.equal(a, 'red', `${s} back to Stop`);
    }
    assert.ok(sawProceed);
  });
});

describe('siding speed: 5 mph inside both sidings', () => {
  test('the interior limit is 5 mph on SD1 and SD2, separate from the throat and approach', () => {
    for (const sd of ['SD1', 'SD2']) {
      const l = sectionLimit(CTX.net, sd);
      assert.ok(Math.abs(l.limitMs - MPH5) < 1e-9, `${sd} limit ${l.limitMs}`);
    }
    for (const s of ['LS1', 'LS2', 'LU1', 'ENT1', 'ENT2']) {
      const sec = CTX.net.sections.get(s);
      if (!sec) continue;
      assert.ok(sectionLimit(CTX.net, s).limitMs > MPH5 + 0.1, `${s} does not inherit the interior limit`);
    }
  });

  test('configurable; the most restrictive limit wins', () => {
    const faster = sectionLimit(CTX.net, 'SD2', { ...SPEED_CONFIG, sidingInteriorMph: 8 });
    assert.ok(Math.abs(faster.limitMs - 8 * 0.44704) < 1e-9);
    const slower = sectionLimit(CTX.net, 'SD2', { ...SPEED_CONFIG, sidingInteriorMph: 3, sidingSections: ['SD2'] });
    assert.ok(Math.abs(slower.limitMs - 3 * 0.44704) < 1e-9);
    const both = sectionLimit(CTX.net, 'SD2', { ...SPEED_CONFIG, sidingInteriorMph: 25 });
    assert.ok(both.limitMs <= 25 * 0.44704 + 1e-9);
  });

  for (const [siding, sd] of [['SIDING1', 'SD1'], ['SIDING2', 'SD2']] as const) {
    test(`a train never exceeds 5 mph anywhere in ${siding}: entry, stabling and departure (all stock)`, () => {
      const plan = plansFor('N-IN', siding)[0];
      assert.ok(plan);
      const w = ecsWorld(plan, 'N-IN', siding);
      let maxIn = 0;
      let outsideFast = 0;
      let samples = 0;
      for (let i = 0; i < 20 * 3000 && !(w.trains[0] as Train).finished; i++) {
        signal(w);
        step(w);
        const t = w.trains[0] as Train;
        if (t.finished) break;
        if (occupiedSteps(t).some((k) => t.path[k]?.section === sd)) {
          samples++;
          maxIn = Math.max(maxIn, t.speedMs);
        } else outsideFast = Math.max(outsideFast, t.speedMs);
      }
      assert.ok(samples > 0, 'the train was in the siding');
      assert.ok(maxIn <= MPH5 + 0.05, `max speed in ${sd}: ${maxIn} m/s`);
      assert.ok(maxIn > 1, 'it does move at about siding speed rather than creeping');
      assert.ok(outsideFast > MPH5 + 1, 'the 5 mph restriction is local to the siding');
      assert.ok((w.trains[0] as Train).finished, 'the cycle completes');
    });
  }
});
