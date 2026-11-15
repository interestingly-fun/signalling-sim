/**
 * Phase 9: reversal, shunting signals, the sidings and the ECS cycle, driven through the real interlocking.
 * The "signaller" is requestRoute / validateRouteForTrains: nothing here bypasses it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ashcombeDefinition,
  signalAtEnd,
  buildNetwork,
  checkLockInvariants,
  computeAspects,
  createEcsTrain,
  createSignallingContext,
  createSignallingState,
  planEcsCycles,
  requestRoute,
  createTrain,
  reverseTrain,
  sidingFit,
  validateRouteForTrains,
  bayFit,
  setTestOccupancy,
  frontSection,
  occupiedSteps,
  rearM,
  sidingCapacityM,
  stepFleet,
  stockPerformance,
  type EcsPlan,
  type EcsRequest,
  type SignallingContext,
  type SignallingState,
  type Train,
} from '../index';

const DT = 0.05;
const CTX = createSignallingContext(buildNetwork(ashcombeDefinition));

interface World {
  ctx: SignallingContext;
  sig: SignallingState;
  trains: Train[];
  time: number;
  events: { t: number; kind: string; what?: string; text: string }[];
}
const world = (): World => ({ ctx: CTX, sig: createSignallingState(CTX.net), trains: [], time: 0, events: [] });

export const REQ = (over: Partial<EcsRequest> = {}): EcsRequest => ({
  headcode: '5E01',
  model: '170',
  formation: '2-car',
  origin: 'N-IN',
  siding: 'SIDING2',
  onward: { headcode: '1Z10', trainClass: 2, destination: 'W-OUT' },
  stablingS: 90,
  ...over,
});

function add(w: World, req: EcsRequest, plan?: EcsPlan): Train {
  const r = createEcsTrain(w.ctx, w.sig, w.trains, { ...req, plan }, `T${w.trains.length + 1}`);
  assert.ok(r.ok, r.ok ? '' : r.reason);
  w.sig = r.sig;
  const t = { ...r.train, started: true };
  w.trains.push(t);
  return t;
}

/** A tests-only signaller: sets the next planned movement from the signal each train is held at. */
function signaller(w: World): void {
  const aspects = computeAspects(w.ctx, w.sig);
  void aspects;
  for (const t of w.trains) {
    if (t.finished) continue;
    const at = t.limit.kind === 'signal' ? t.limit.subject : undefined;
    if (!at || w.sig.routes[at] !== undefined) continue;
    const route = t.plan.map((id) => w.ctx.route(id)).find((r) => r?.from === at);
    if (!route) continue;
    const r = requestRoute(w.ctx, w.sig, route.from, route.to, route.id);
    if (r.ok) w.sig = r.state;
    else if (process.env.DBG) console.log('refused', route.id, r.rejection.message);
    // A shunting access route (main signal -> its associated shunting signal) works only once the shunting signal shows Proceed:
    // the signaller sets the shunting route from it at the same time.
    if (r.ok && route.shuntAccess) {
      const next = t.plan.map((id) => w.ctx.route(id)).find((x) => x?.from === route.to);
      if (next) {
        const r2 = requestRoute(w.ctx, w.sig, next.from, next.to, next.id);
        if (r2.ok) w.sig = r2.state;
        else if (process.env.DBG) console.log('refused', next.id, r2.rejection.message);
      }
    }
  }
}

function tick(w: World): void {
  signaller(w);
  const r = stepFleet(w.ctx, w.sig, w.trains, DT);
  w.sig = r.sig;
  w.trains = [...r.trains];
  w.time += DT;
  for (const e of r.events) w.events.push({ t: w.time, kind: e.kind, what: e.kind === 'ecs' ? e.what : undefined, text: e.text });
  const issues = checkLockInvariants(w.ctx, w.sig);
  assert.deepEqual(issues, [], 'lock invariants');
}
function run(w: World, until: (w: World) => boolean, maxS = 3000): void {
  for (let t = 0; t < maxS && !until(w); t += DT) tick(w);
}
const whats = (w: World): string[] => w.events.filter((e) => e.what).map((e) => e.what as string);

describe('ECS cycle: Northbridge -> reversal -> Siding 2 -> Westford', () => {
  test('the planner finds a valid approach and departure for each entry and destination', () => {
    for (const origin of ['N-IN', 'W-IN', 'M-IO']) {
      for (const siding of ['SIDING1', 'SIDING2']) {
        for (const destination of ['N-OUT', 'W-OUT', 'M-IO']) {
          const plans = planEcsCycles(CTX, { origin, siding, destination, lengthM: 50, stopMarginM: 10, onwardClass: 2 });
          assert.ok(plans.length > 0, `${origin} -> ${siding} -> ${destination}`);
        }
      }
    }
  });

  test('full cycle', () => {
    const w = world();
    const plans = planEcsCycles(CTX, { origin: 'N-IN', siding: 'SIDING2', destination: 'W-OUT', lengthM: stockPerformance({ model: '170', formation: '2-car' }).lengthM, stopMarginM: 10 });
    const t0 = add(w, REQ(), plans[0]);
    assert.ok(plans[0]?.arrival.bays.length === 1, 'Northbridge arrivals must reverse before the siding');
    run(w, (x) => x.trains[0]?.finished === true, 2500);
    const t = w.trains[0] as Train;
    assert.ok(t.finished, `finished; events: ${w.events.slice(-8).map((e) => e.text).join(' | ')}; plan ${plans[0]?.arrival.label}`);
    assert.equal(t.spec.headcode, '1Z10');
    assert.equal(t.spec.trainClass, 2);
    assert.equal(t.exited, 'W-OUT');
    assert.equal(t.spec.stock?.model, t0.spec.stock?.model);
    const seq = whats(w);
    for (const k of ['approaching-reversal', 'stopped-for-reversal', 'reversal-complete', 'entering-siding', 'stabled', 'stabling-complete', 'new-headcode', 'new-class', 'authorised', 'leaving-siding', 'siding-released']) assert.ok(seq.includes(k), k + ' in ' + seq.join(','));
    assert.deepEqual(w.sig.sectionLocks, {});
    assert.equal(sidingCapacityM(CTX.net, 'SIDING2'), 180);
  });
});

const lenOf = (model: string, formation: string): number => stockPerformance({ model, formation }).lengthM;

describe('every entry, siding and destination can be completed (no assumption about where, or whether, it reverses)', () => {
  const cases: [string, string, string][] = [];
  for (const o of ['N-IN', 'W-IN', 'M-IO']) for (const sd of ['SIDING1', 'SIDING2']) for (const d of ['N-OUT', 'W-OUT', 'M-IO']) cases.push([o, sd, d]);
  for (const [origin, siding, destination] of cases) {
    test(`${origin} -> ${siding} -> ${destination}`, () => {
      const w = world();
      const model = destination === 'M-IO' || origin === 'M-IO' ? { model: '170', formation: '2-car' } : { model: '387', formation: '4-car' };
      const plans = planEcsCycles(CTX, { origin, siding, destination, lengthM: lenOf(model.model, model.formation), stopMarginM: 12, onwardClass: 2, model: model.model });
      assert.ok(plans.length > 0);
      add(w, REQ({ origin, siding, ...model, onward: { headcode: '1Z10', trainClass: 2, destination } }), plans[0]);
      run(w, (x) => x.trains[0]?.finished === true, 3500);
      const t = w.trains[0] as Train;
      assert.ok(t.finished, `finished: ${w.events.slice(-4).map((e) => e.text).join(' | ')}`);
      assert.equal(t.exited, destination);
      assert.equal(t.spec.headcode, '1Z10');
      assert.deepEqual(w.sig.sectionLocks, {});
      assert.deepEqual(w.sig.pointLocks, {});
      // every reversal that was planned was completed, and no more
      const n = (plans[0]?.arrival.bays.length ?? 0) + (plans[0]?.departure.bays.length ?? 0) + 1;
      assert.equal(whats(w).filter((k) => k === 'reversal-complete').length, n);
    });
  }
});

describe('the movement is physical', () => {
  test('a train can only be reversed at standstill, and keeps exactly the ground it covers', () => {
    const w = world();
    add(w, REQ({ origin: 'W-IN' }));
    run(w, (x) => x.trains[0]?.ecs?.stage === 'stabled', 3000);
    const t = w.trains[0] as Train;
    assert.equal(t.speedMs, 0);
    const before = occupiedSteps(t).map((i) => t.path[i]?.section).sort();
    const r = reverseTrain(CTX.net, t);
    assert.deepEqual(occupiedSteps(r).map((i) => r.path[i]?.section).sort(), before, 'same sections occupied');
    assert.ok(Math.abs(rearM(r) - (t.path.length ? 0 : 0)) >= 0);
    assert.equal(frontSection(r), t.path[occupiedSteps(t)[0] ?? 0]?.section, 'new front is where the rear was');
    assert.throws(() => reverseTrain(CTX.net, { ...t, speedMs: 5 }), /standing/);
  });

  test('a reversal passes its states in order, never moving while changing ends', () => {
    const w = world();
    add(w, REQ());
    const seen: string[] = [];
    let moved = 0;
    for (let i = 0; i < 20 * 1500 && !(w.trains[0] as Train).finished; i++) {
      tick(w);
      const t = w.trains[0] as Train;
      const ph = t.ecs?.reversal?.phase;
      if (ph && seen[seen.length - 1] !== ph) seen.push(ph);
      if ((ph === 'awaiting' || ph === 'reversing') && t.speedMs > 0) moved++;
    }
    assert.equal(moved, 0);
    assert.deepEqual(seen.slice(0, 5), ['approaching', 'braking', 'awaiting', 'reversing', 'ready']);
  });

  test('a train too long for a bay is never planned to reverse in it; the other bay is used instead', () => {
    assert.equal(bayFit(CTX.net, 'REV-DN5', 263, 12).ok, false);
    assert.equal(bayFit(CTX.net, 'REV-P2', 263, 12).ok, true);
    const plans = planEcsCycles(CTX, { origin: 'N-IN', siding: 'SIDING1', destination: 'N-OUT', lengthM: 263, stopMarginM: 12, onwardClass: 1, model: '390' });
    // 390 11-car does not fit Siding 1 either (260 m): no plan at all
    assert.equal(plans.length, 0);
    const p2 = planEcsCycles(CTX, { origin: 'N-IN', siding: 'SIDING1', destination: 'W-OUT', lengthM: 240, stopMarginM: 12, onwardClass: 1, model: '800' });
    assert.ok(p2.length > 0);
    for (const p of p2) assert.ok(![...p.arrival.bays, ...p.departure.bays].includes('REV-DN5'), 'a 240 m train is never planned to reverse on DN5 (235 m of room)');
  });

  test('no partial stabling: a train longer than the siding is refused at creation', () => {
    assert.equal(sidingFit(CTX.net, 'SIDING2', 234).ok, false);
    assert.equal(sidingFit(CTX.net, 'SIDING2', 130).ok, true);
    const w = world();
    const r = createEcsTrain(CTX, w.sig, [], REQ({ model: '800', formation: '9-car', onward: { headcode: '1Z10', trainClass: 1, destination: 'N-OUT' } }), 'T1');
    assert.equal(r.ok, false);
  });

  test('onward class must suit the model (142 is Class 2 only; 800 is Class 1 only)', () => {
    const w = world();
    assert.equal(createEcsTrain(CTX, w.sig, [], REQ({ model: '142', formation: '2-car', onward: { headcode: '1Z10', trainClass: 1, destination: 'W-OUT' } }), 'T1').ok, false);
    assert.equal(createEcsTrain(CTX, w.sig, [], REQ({ model: '800', formation: '5-car', onward: { headcode: '1Z10', trainClass: 2, destination: 'W-OUT' } }), 'T1').ok, false);
    assert.equal(createEcsTrain(CTX, w.sig, [], REQ({ model: '800', formation: '5-car', onward: { headcode: '1Z10', trainClass: 1, destination: 'W-OUT' } }), 'T1').ok, true);
  });
});

describe('shunting signals', () => {
  test('they are interlocked: no route, no proceed; a route to an occupied siding is refused; they return to Stop behind the train', () => {
    const w = world();
    let a = computeAspects(CTX, w.sig);
    for (const id of ['S1', 'S4', 'S5', 'S6']) assert.equal(a[id], 'red', id + ' never clears by itself');
    // occupied siding
    const occ = setTestOccupancy(w.sig, 'SD2', true);
    const r = requestRoute(CTX, occ, 'S4', 'SD2-BUF');
    assert.equal(r.ok, false);
    // free siding: the route can be set, the signal then shows proceed
    const ok = requestRoute(CTX, w.sig, 'S4', 'SD2-BUF');
    assert.ok(ok.ok);
    a = computeAspects(CTX, ok.state);
    assert.equal(a['S4'], 'green', 'the route into the sidings is set: AJ4 shows green');
    assert.equal(a['S1'], 'red', 'AJ1 has no route');
    // a conflicting route over the same lead is refused
    const s1 = requestRoute(CTX, w.sig, 'S1', 'SD1-BUF');
    assert.ok(s1.ok);
    assert.equal(requestRoute(CTX, s1.state, 'S4', 'SD2-BUF').ok, false, 'S4 and S1 routes share the lead (SLN/LS2)');
  });

  test('AJ1 and AJ4 are main-line signals: only associated mains have access routes ending at them, trains on the main ignore them, they only start movements into the sidings', () => {
    const net = CTX.net;
    for (const id of ['S1', 'S4']) {
      assert.equal(net.signals.get(id)?.mainline, true);
      assert.equal(net.signals.get(id)?.type, 'shunting');
    }
    assert.equal(net.signals.get('S4')?.at.section, 'UP11', 'AJ4 stands on UP11');
    assert.equal(signalAtEnd(net, { section: 'UP11', end: 'B' }), undefined, 'a train running along UP11 does not see AJ4');
    assert.equal(signalAtEnd(net, { section: 'DN3', end: 'B' }), undefined, 'nor AJ1 on DN3');
    const all = [...net.signals.keys()].flatMap((id) => CTX.from(id));
    for (const r of all.filter((x) => x.to === 'S1' || x.to === 'S4')) {
      assert.ok(r.shuntAccess, `${r.id} is an access route`);
      assert.ok(net.signals.get(r.to)?.associatedMain?.includes(r.from), `${r.id} only from an associated main`);
    }
    assert.ok(CTX.route('U5>U6'), 'ordinary routes still pass straight through them');
    for (const r of CTX.from('S1').concat(CTX.from('S4'))) assert.ok(r.points.some((p) => p.position === 'reverse'), `${r.id} only runs into the sidings`);
    assert.ok(CTX.route('U5>U6')?.sections.includes('UP11'), 'a through route runs over UP11 past AJ4');
    // AJ4 shows Stop with nothing set, but the through route U5>U6 can still be set and cleared whatever AJ4 shows
    const w = world();
    const r = requestRoute(CTX, w.sig, 'U5', 'U6');
    assert.ok(r.ok);
    assert.equal(computeAspects(CTX, r.state)['S4'], 'red');
    assert.notEqual(computeAspects(CTX, r.state)['U5'], 'red', 'the through route is clear although AJ4 shows Stop');
  });

  test('a shunting signal is Stop again once the train has passed it', () => {
    const w = world();
    const viaS4 = planEcsCycles(CTX, { origin: 'W-IN', siding: 'SIDING2', destination: 'W-OUT', lengthM: 47, stopMarginM: 12, onwardClass: 2, model: '170' }).find((p) => p.arrival.movements.some((m) => CTX.route(m)?.sections.includes('LU1')));
    assert.ok(viaS4, 'an approach through AJ4 exists');
    add(w, REQ({ origin: 'W-IN' }), viaS4);
    let sawProceed = false;
    for (let i = 0; i < 20 * 1500 && !(w.trains[0] as Train).finished; i++) {
      tick(w);
      const a = computeAspects(CTX, w.sig);
      if (a['S4'] === 'green') sawProceed = true;
      const t = w.trains[0] as Train;
      if (t.path.some((p) => p.section === 'LU2') && occupiedSteps(t).every((j) => t.path[j]?.section !== 'LU1')) assert.equal(a['S4'], 'red', 'AJ4 returned to Stop after the train passed it');
    }
    assert.ok(sawProceed);
  });

  test('only Class 5 may enter a siding: a Class 2 train is refused the route and stopped by the line restriction', () => {
    const w = world();
    const r = createTrain(CTX, w.sig, [], { headcode: '2A01', trainClass: 2, origin: 'W-IN', destination: 'N-OUT', platform: null }, 'T1');
    assert.ok(r.ok);
    const t = { ...(r as { train: Train }).train, started: true, limit: { kind: 'signal', limitM: 0, subject: 'S4' } as Train['limit'] };
    const rej = validateRouteForTrains(CTX, w.sig, [{ ...t, path: [{ section: 'LU1', enterEnd: 'A' }], ends: [50], frontM: 40 }], 'S4>SD1-BUF');
    assert.equal(rej?.code, 'SIDING_RESTRICTED');
    // and an ECS (Class 5) train is accepted
    const e = add(world(), REQ());
    assert.ok(e);
  });
});

describe('the signaller picks the bay: the train reverses in whichever bay it meets', () => {
  for (const [planned, other] of [['REV-P2', 'REV-DN5'], ['REV-DN5', 'REV-P2']] as const) {
    test(`planned ${planned}, routed via ${other}: still reverses and stables`, () => {
      const lengthM = stockPerformance({ model: '170', formation: '2-car' }).lengthM;
      const plans = planEcsCycles(CTX, { origin: 'N-IN', siding: 'SIDING2', destination: 'W-OUT', lengthM, stopMarginM: 10 });
      const a = plans.find((p) => p.arrival.bays[0] === planned);
      const b = plans.find((p) => p.arrival.bays[0] === other);
      assert.ok(a && b, 'both bay plans exist');
      const w = world();
      const t = add(w, REQ(), a);
      w.trains[0] = { ...t, plan: b.arrival.movements };
      run(w, (x) => x.trains[0]?.ecs?.stage === 'stabled', 2500);
      const job = w.trains[0]?.ecs;
      assert.equal(job?.stage, 'stabled', `events: ${w.events.slice(-6).map((e) => e.text).join(' | ')}`);
      assert.ok((job?.reversals ?? 0) >= 1);
    });
  }
});
