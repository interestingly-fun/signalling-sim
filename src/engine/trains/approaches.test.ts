import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ashcombeDefinition,
  buildNetwork,
  computeAspects,
  createSignallingContext,
  createSignallingState,
  JOURNEYS,
  occupiedSteps,
  rearM,
  requestRoute,
  setTestOccupancy,
  spawnTrain,
  stepTrain,
  testTrainSpec,
  validateNetworkDef,
  type SignallingState,
  type Train,
  type TrainEvent,
} from '../index';

const net = buildNetwork(ashcombeDefinition);
const ctx = createSignallingContext(net);
const fresh = () => createSignallingState(net);

/**
 * Consecutive AUTOMATIC signals met going inward from an entry boundary
 * (until the first manual signal) or outward to an exit boundary (back from the boundary).
 */
function entryAutomaticSignals(boundary: string): string[] {
  const b = net.boundaries.get(boundary);
  assert.ok(b, boundary);
  // first signal the train meets: the one standing at the end of the boundary section (nearest first)
  const first = [...net.signals.values()].find((s) => s.at.section === b.at.section && s.at.end !== b.at.end);
  const out: string[] = [];
  let cur = first;
  while (cur && cur.type === 'automatic') {
    out.push(cur.id);
    const next = ctx.from(cur.id)[0];
    cur = next && next.toKind === 'signal' ? net.signals.get(next.to) : undefined;
  }
  return out;
}
function exitAutomaticSignals(boundary: string): string[] {
  const out: string[] = [];
  let target = boundary;
  for (;;) {
    const r = ctx.routes.find((x) => x.to === target && net.signals.get(x.from)?.type === 'automatic');
    if (!r) return out;
    out.push(r.from);
    target = r.from;
  }
}

describe('Phase 3.5: every external approach has at least three consecutive automatic signals', () => {
  test('the extended topology is still valid', () => assert.deepEqual(validateNetworkDef(ashcombeDefinition), []));

  const cases: [string, string[]][] = [
    ['W-IN', ['UW2', 'UW1', 'U1']],
    ['N-IN', ['DE2', 'DE1', 'D1']],
    ['M-IO', ['MW3', 'MW2', 'MW1']],
  ];
  for (const [boundary, expected] of cases) {
    test(`entering at ${boundary}: ${expected.join(' → ')} (then a manual signal)`, () => {
      assert.deepEqual(entryAutomaticSignals(boundary), expected);
      assert.ok(entryAutomaticSignals(boundary).length >= 3);
    });
  }
  const exits: [string, string[]][] = [
    ['W-OUT', ['DW2', 'DW1', 'D4']],
    ['N-OUT', ['UE1', 'U6']], // U5 became manual in Phase 5, so only two automatic signals precede the exit
    ['M-IO', ['MX2', 'MX1', 'M2']],
  ];
  for (const [boundary, expected] of exits) {
    test(`leaving at ${boundary}: ${expected.join(' ← ')} nearest the boundary first`, () => {
      assert.deepEqual(exitAutomaticSignals(boundary), expected);
      assert.ok(exitAutomaticSignals(boundary).length >= (boundary === 'N-OUT' ? 2 : 3));
    });
  }

  test('new sections have unique IDs, the right direction and an automatic signal at the end of each approach block', () => {
    const added = ['UPW2', 'UPW1', 'UPE1', 'DNW1', 'DNW2', 'DNE1', 'DNE2', 'BRM1', 'BRM2', 'BRM3'];
    for (const id of added) assert.ok(net.sections.has(id), id);
    for (const id of ['UPW2', 'UPW1', 'UPE1']) assert.equal(net.sections.get(id)?.traffic, 'AB', id);
    for (const id of ['DNW1', 'DNW2', 'DNE1', 'DNE2']) assert.equal(net.sections.get(id)?.traffic, 'BA', id);
    for (const id of ['BRM1', 'BRM2', 'BRM3']) assert.equal(net.sections.get(id)?.traffic, 'both', `${id}: the branch stays single track`);
    const signals = ['UW2', 'UW1', 'UE1', 'DE2', 'DE1', 'DW1', 'DW2', 'MW3', 'MW2', 'MW1', 'MX1', 'MX2'];
    for (const id of signals) {
      assert.equal(net.signals.get(id)?.type, 'automatic', id);
      assert.equal(ctx.from(id).length, 1, `${id} protects exactly one movement`);
    }
  });

  test('boundaries are now on the outer new sections; the old inner sections are plain links', () => {
    assert.deepEqual(net.boundaries.get('W-IN')?.at, { section: 'UPW2', end: 'A' });
    assert.deepEqual(net.boundaries.get('N-IN')?.at, { section: 'DNE2', end: 'B' });
    assert.deepEqual(net.boundaries.get('M-IO')?.at, { section: 'BRM3', end: 'A' });
    assert.deepEqual(net.boundaries.get('W-OUT')?.at, { section: 'DNW2', end: 'A' });
    assert.deepEqual(net.boundaries.get('N-OUT')?.at, { section: 'UPE1', end: 'B' });
  });

  test('the branch is still one bi-directional track with M1 and M2 where they were', () => {
    assert.deepEqual(net.signals.get('M1')?.at, { section: 'BR1', end: 'B' });
    assert.deepEqual(net.signals.get('M2')?.at, { section: 'BR2', end: 'A' });
    assert.equal(net.signals.get('M1')?.type, 'manual');
    assert.deepEqual(ctx.from('M1').map((r) => r.id), ['M1>U3']);
  });
});

describe('automatic aspects on the new approaches', () => {
  test('a clear approach ahead of a Red manual signal shows Green / Double Yellow / Yellow back from it', () => {
    const a = computeAspects(ctx, fresh());
    // U2 is manual and Red: U1 Yellow, UW1 Double Yellow, UW2 Green
    assert.equal(a['U2'], 'red');
    assert.equal(a['U1'], 'yellow');
    assert.equal(a['UW1'], 'double-yellow');
    assert.equal(a['UW2'], 'green');
    // clear to the boundary: all Green
    assert.equal(a['UE1'], 'green');
    assert.equal(a['U6'], 'green');
    assert.equal(a['DW2'], 'green');
  });

  test('occupying a new section turns the signal behind it Red and the one before that Yellow', () => {
    const a = computeAspects(ctx, setTestOccupancy(fresh(), 'UPW1', true));
    assert.equal(a['UW2'], 'red', 'UW2 protects UPW1');
    assert.equal(a['UW1'], 'double-yellow', 'UW1 protects UP1 and sees U1 Yellow');
    const b = computeAspects(ctx, setTestOccupancy(fresh(), 'DNW1', true));
    assert.equal(b['DW1'], 'red');
    assert.equal(b['D4'], 'yellow');
    const c = computeAspects(ctx, setTestOccupancy(fresh(), 'BRM1', true));
    assert.equal(c['MW2'], 'red', 'inbound MW2 protects BRM1');
    assert.equal(c['MX1'], 'red', 'outbound MX1 protects BRM1');
  });

  test('the branch is single track: an outbound movement over BR1 turns the opposite automatic signal Red', () => {
    const a = computeAspects(ctx, setTestOccupancy(fresh(), 'BR1', true));
    assert.equal(a['MW1'], 'red');
    assert.equal(a['M2'], 'red');
  });
});

// ---------------------------------------------------------------------------------------------
describe('trains traverse the extended approaches', () => {
  function set(sig: SignallingState, pairs: [string, string][]): SignallingState {
    let s = sig;
    for (const [a, b] of pairs) {
      const r = requestRoute(ctx, s, a, b);
      assert.ok(r.ok, r.ok ? '' : `${a}>${b}: ${r.rejection.message}`);
      s = r.state;
    }
    return s;
  }
  function journey(id: string, sig: SignallingState) {
    const j = JOURNEYS.find((x) => x.id === id);
    assert.ok(j, id);
    const sp = spawnTrain(net, sig, testTrainSpec(j, { trainClass: 2 }));
    assert.ok(sp.ok, sp.ok ? '' : sp.reason);
    let train: Train = { ...sp.train, started: true };
    let s = sp.sig;
    const events: TrainEvent[] = [];
    const checks = { straddled: false };
    for (let i = 0; i < 12000 && !train.finished; i++) {
      const r = stepTrain(ctx, s, train, 0.05);
      s = r.sig;
      train = r.train;
      events.push(...r.events);
      // front/rear occupancy matches the metres exactly, on every step
      if (!train.finished) {
        const want = new Set(occupiedSteps(train).map((k) => train.path[k]?.section));
        if (want.size >= 2) checks.straddled = true;
        for (const [sec, owner] of Object.entries(s.network.sectionOccupancy)) assert.equal(owner === train.id, want.has(sec), `${sec} at front ${train.frontM.toFixed(0)}, rear ${rearM(train).toFixed(0)}`);
      }
    }
    return { train, sig: s, events, checks };
  }

  test('Westford → Northbridge (UP main) passes UW2, UW1, U1 … U6, UE1 and leaves by N-OUT', () => {
    const w = journey('westford-northbridge', set(fresh(), [['U2', 'U3'], ['U3', 'U4'], ['U4', 'U5'], ['U5', 'U6']]));
    assert.equal(w.train.exited, 'N-OUT');
    assert.equal(w.train.path[0]?.section, 'UPW2');
    assert.equal(w.train.path[w.train.path.length - 1]?.section, 'UPE1');
    const passed = w.events.filter((e) => e.kind === 'passed-signal').map((e) => (e.kind === 'passed-signal' ? e.signal : ''));
    assert.deepEqual(passed, ['UW2', 'UW1', 'U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'UE1']);
    assert.ok(w.checks.straddled);
    assert.deepEqual(w.sig.routes, {});
    assert.ok(Object.values(w.sig.network.sectionOccupancy).every((o) => o === null));
  });

  test('Northbridge → Westford (DOWN main) passes DE2, DE1, D1 … D4, DW1, DW2 and leaves by W-OUT', () => {
    const w = journey('northbridge-westford', set(fresh(), [['D2', 'D3'], ['D3', 'D4']]));
    assert.equal(w.train.exited, 'W-OUT');
    const passed = w.events.filter((e) => e.kind === 'passed-signal').map((e) => (e.kind === 'passed-signal' ? e.signal : ''));
    assert.deepEqual(passed, ['DE2', 'DE1', 'D1', 'D2', 'D3', 'D4', 'DW1', 'DW2']);
  });

  test('Merefield → Northbridge enters over BRM3, BRM2, BRM1, BR1, crosses to the UP main and leaves by N-OUT', () => {
    const w = journey('merefield-northbridge', set(fresh(), [['M1', 'U3'], ['U3', 'U4'], ['U4', 'U5'], ['U5', 'U6']]));
    assert.equal(w.train.exited, 'N-OUT');
    assert.deepEqual(w.train.path.slice(0, 5).map((p) => p.section), ['BRM3', 'BRM2', 'BRM1', 'BR1', 'BR2']);
    const passed = w.events.filter((e) => e.kind === 'passed-signal').map((e) => (e.kind === 'passed-signal' ? e.signal : ''));
    assert.deepEqual(passed.slice(0, 4), ['MW3', 'MW2', 'MW1', 'M1']);
    assert.equal(passed[passed.length - 1], 'UE1');
  });

  test('Northbridge → Merefield leaves over BR1, BRM1, BRM2, BRM3 passing M2, MX1, MX2', () => {
    const w = journey('northbridge-merefield', set(fresh(), [['D2', 'D3'], ['D3', 'M2']]));
    assert.equal(w.train.exited, 'M-IO');
    const passed = w.events.filter((e) => e.kind === 'passed-signal').map((e) => (e.kind === 'passed-signal' ? e.signal : ''));
    assert.deepEqual(passed.slice(-3), ['M2', 'MX1', 'MX2']);
    assert.deepEqual(w.train.path.slice(-4).map((p) => p.section), ['BR1', 'BRM1', 'BRM2', 'BRM3']);
  });

  test('a train does not enter the area while its entry approach section is occupied', () => {
    const j = JOURNEYS[0];
    assert.ok(j);
    assert.equal(spawnTrain(net, setTestOccupancy(fresh(), 'DNE2', true), testTrainSpec(j)).ok, false);
  });

  test('an occupied new section stops the train short of the signal protecting it', () => {
    const j = JOURNEYS[0];
    assert.ok(j);
    const blocked = setTestOccupancy(set(fresh(), [['D2', 'D3'], ['D3', 'D4']]), 'DNE1', true);
    const sp = spawnTrain(net, blocked, testTrainSpec(j));
    assert.ok(sp.ok);
    let train: Train = { ...sp.train, started: true };
    let s = sp.sig;
    let maxFront = 0;
    for (let i = 0; i < 4000; i++) {
      const r = stepTrain(ctx, s, train, 0.05);
      s = r.sig;
      train = r.train;
      maxFront = Math.max(maxFront, train.frontM);
    }
    assert.ok(maxFront < 200, `held short of DE2 at 200 m (reached ${maxFront.toFixed(1)})`);
    assert.equal(train.state, 'stopped');
    assert.match(train.holdReason, /DE2/);
  });
});
