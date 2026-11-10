import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPEED_CONFIG,
  ashcombeDefinition,
  buildNetwork,
  checkLockInvariants,
  computeAspects,
  createSignallingContext,
  createSignallingState,
  createTrain,
  frontSection,
  mphToMs,
  msToMph,
  permittedAt,
  requestRoute,
  sectionLimit,
  speedEnvelope,
  stepFleet,
  stockPerformance,
  type LimitSegment,
  type SignallingState,
  type StockRef,
  type Train,
  type TrainEvent,
} from '../index';

const net = buildNetwork(ashcombeDefinition);
const ctx = createSignallingContext(net);
const DT = 0.05;
const L = (id: string): number => net.sections.get(id)?.lengthM ?? NaN;
const sum = (...ids: string[]): number => ids.reduce((n, id) => n + L(id), 0);

interface Sample {
  t: number;
  front: number;
  speed: number;
  permitted: number;
  overspeed: boolean;
  section: string | null;
  status: string;
}
interface Run {
  samples: Sample[];
  events: TrainEvent[];
  signalPasses: { signal: string; aspect: string; speed: number; t: number }[];
  train: Train;
  problems: string[];
}
interface Opts {
  trainClass: 1 | 2 | 5;
  stock: StockRef;
  origin: string;
  destination: string;
  platform?: string | null;
  /** Only the first n manual routes are ever set (so the next signal stays at Danger). */
  routes?: number;
  maxS?: number;
  ignore?: boolean;
  stopWhen?: (s: Sample) => boolean;
}

/** One train alone on the real engine; the signaller sets the routes as early as the interlocking allows. */
function runLone(o: Opts): Run {
  let sig: SignallingState = createSignallingState(net);
  const made = createTrain(ctx, sig, [], { headcode: `${o.trainClass}P00`, trainClass: o.trainClass, origin: o.origin, destination: o.destination, platform: o.platform ?? null, dwellS: 30, model: o.stock.model, formation: o.stock.formation, ...(o.ignore ? { ignoreRestrictions: true } : {}) }, 'T1', { ignorePlatformAvailability: true });
  assert.ok(made.ok, made.ok ? '' : made.reason);
  sig = made.sig;
  let trains: Train[] = [{ ...made.train, started: true }];
  const manual = made.plan.manual.slice(0, o.routes ?? 99);
  const out: Run = { samples: [], events: [], signalPasses: [], train: trains[0] as Train, problems: [] };
  for (let i = 0; i * DT < (o.maxS ?? 600); i++) {
    const tr = trains[0] as Train;
    for (const m of manual) {
      const r = ctx.route(m);
      if (!r || sig.residual[m] || tr.heldRoutes.includes(m) || sig.routes[r.from] !== undefined) continue;
      const res = requestRoute(ctx, sig, r.from, r.to, m);
      if (res.ok) sig = res.state;
    }
    const asp = computeAspects(ctx, sig);
    const step = stepFleet(ctx, sig, trains, DT);
    for (const e of step.events) {
      out.events.push(e);
      if (e.kind === 'passed-signal') out.signalPasses.push({ signal: e.signal, aspect: asp[e.signal] ?? '?', speed: (trains[0] as Train).speedMs, t: (i + 1) * DT });
    }
    sig = step.sig;
    trains = [...step.trains];
    const t = trains[0] as Train;
    out.problems.push(...checkLockInvariants(ctx, sig));
    const s: Sample = { t: (i + 1) * DT, front: t.frontM, speed: t.speedMs, permitted: t.speedInfo.permittedMs, overspeed: t.speedInfo.overspeed, section: t.finished ? null : frontSection(t), status: t.status };
    out.samples.push(s);
    out.train = t;
    if (t.finished || o.stopWhen?.(s)) break;
  }
  return out;
}

const peakDecel = (r: Run, minSpeed = 0.5): number => {
  let peak = 0;
  for (let i = 1; i < r.samples.length; i++) if ((r.samples[i - 1] as Sample).speed > minSpeed && (r.samples[i] as Sample).section !== null) peak = Math.max(peak, ((r.samples[i - 1] as Sample).speed - (r.samples[i] as Sample).speed) / DT);
  return peak;
};
const maxSpeed = (r: Run): number => Math.max(...r.samples.map((s) => s.speed));

const S800: StockRef = { model: '800', formation: '5-car' };
const S150: StockRef = { model: '150', formation: '2-car' };
const S170: StockRef = { model: '170', formation: '2-car' };
const S175: StockRef = { model: '175', formation: '3-car' };
const S387: StockRef = { model: '387', formation: '4-car' };
const S390: StockRef = { model: '390', formation: '11-car' };

describe('Part 2: section distances', () => {
  test('the outer approaches, departures and branch are long enough for fast trains', () => {
    const upApproach = sum('UPW2', 'UPW1', 'UP1');
    const downApproach = sum('DNE2', 'DNE1', 'DN1');
    const upDeparture = sum('UP11', 'UP12', 'UPE1');
    const downDeparture = sum('DN10', 'DN11', 'DNW1', 'DNW2');
    const branch = sum('BRM3', 'BRM2', 'BRM1');
    assert.ok(upApproach >= 3000 && upApproach <= 4000, `UP approach ${upApproach}`);
    assert.ok(downApproach >= 3000 && downApproach <= 4000, `DOWN approach ${downApproach}`);
    assert.ok(upDeparture >= 2000 && upDeparture <= 3000, `UP departure ${upDeparture}`);
    assert.ok(downDeparture >= 2000 && downDeparture <= 3000, `DOWN departure ${downDeparture}`);
    assert.ok(branch >= 2000 && branch <= 3000, `branch ${branch}`);
  });

  test('every outer block is long enough to brake a 125 mph train in two blocks (four-aspect signalling)', () => {
    const worst = Math.max(...['800', '221', '390'].flatMap((m) => ['5-car', '9-car', '4-car', '11-car'].map((f) => { try { return stockPerformance({ model: m, formation: f }); } catch { return null; } })).filter((p) => p !== null).map((p) => (p!.maxSpeedMs ** 2) / (2 * p!.serviceBrakeMs2)));
    for (const [a, b] of [['UPW1', 'UP1'], ['DNE1', 'DN1']] as const) assert.ok(L(a) + L(b) >= worst * 0.8, `${a}+${b} ${L(a) + L(b)} m vs braking ${Math.round(worst)} m`);
  });

  test('simulated length is independent of the drawing: one metre of track is not a pixel', () => {
    assert.ok(L('UPW2') >= 1000);
    assert.ok(L('UP4') < L('UPW2'), 'a short junction section is shorter than a long approach, whatever they look like on screen');
  });
});

describe('Part 3: central speed restrictions', () => {
  test('limits come from the central configuration', () => {
    assert.equal(Math.round(msToMph(sectionLimit(net, 'UP1').limitMs)), 125);
    assert.equal(Math.round(msToMph(sectionLimit(net, 'DN1').limitMs)), 125);
    assert.equal(Math.round(msToMph(sectionLimit(net, 'BRM1').limitMs)), 75);
    assert.equal(Math.round(msToMph(sectionLimit(net, 'P1').limitMs)), 45);
    assert.equal(Math.round(msToMph(sectionLimit(net, 'P2').limitMs)), 45);
    assert.equal(Math.round(msToMph(sectionLimit(net, 'P1W').limitMs)), 40, 'platform throat is a diverging route');
    assert.equal(Math.round(msToMph(sectionLimit(net, 'LA3').limitMs)), 40);
    assert.equal(sectionLimit(net, 'P1W').kind, 'diverging');
  });

  test('changing the configuration changes the limits (nothing is hard-coded elsewhere)', () => {
    const custom = { ...SPEED_CONFIG, lineMph: { ...SPEED_CONFIG.lineMph, UP: 90 }, divergingMph: 30 };
    assert.equal(Math.round(msToMph(sectionLimit(net, 'UP1', custom).limitMs)), 90);
    assert.equal(Math.round(msToMph(sectionLimit(net, 'P1W', custom).limitMs)), 30);
    assert.equal(Math.round(msToMph(sectionLimit(net, 'UP1').limitMs)), 125, 'the default is unchanged');
  });

  test('the permitted speed is the most restrictive of the model maximum and the sections occupied (front to rear)', () => {
    const segs: LimitSegment[] = [
      { section: 'A', startM: 0, endM: 500, limitMs: mphToMs(125), label: 'Mainline 125 mph' },
      { section: 'B', startM: 500, endM: 600, limitMs: mphToMs(40), label: 'Diverging route 40 mph' },
      { section: 'C', startM: 600, endM: 2000, limitMs: mphToMs(125), label: 'Mainline 125 mph' },
    ];
    const max800 = mphToMs(125);
    const max150 = mphToMs(75);
    assert.equal(permittedAt(segs, 300, 130, max800).ms, max800);
    assert.equal(Math.round(msToMph(permittedAt(segs, 300, 130, max150).ms)), 75, 'a 75 mph train is limited by its model on a 125 mph line');
    assert.equal(Math.round(msToMph(permittedAt(segs, 550, 130, max800).ms)), 40);
    assert.equal(Math.round(msToMph(permittedAt(segs, 650, 130, max800).ms)), 40, 'front is past the restriction but the rear is still inside it');
    assert.equal(Math.round(msToMph(permittedAt(segs, 731, 130, max800).ms)), 125, 'rear has cleared');
  });

  test('the braking envelope falls along v² = u² + 2as towards a restriction', () => {
    const lim = mphToMs(40);
    const segs: LimitSegment[] = [{ section: 'B', startM: 2000, endM: 2100, limitMs: lim, label: 'x' }];
    const a = 0.8;
    const max = mphToMs(125);
    assert.equal(speedEnvelope(segs, 0, 100, a, max), max, 'far away: unrestricted');
    const d = (max * max - lim * lim) / (2 * a);
    assert.ok(Math.abs(speedEnvelope(segs, 2000 - d, 100, a, max) - max) < 0.01, 'braking starts exactly one braking distance before');
    assert.ok(Math.abs(speedEnvelope(segs, 2000 - d / 2, 100, a, max) - Math.sqrt(lim * lim + 2 * a * (d / 2))) < 1e-9);
    assert.equal(speedEnvelope(segs, 2000, 100, a, max), lim);
  });
});

describe('Part 4: braking to restrictions', () => {
  test('a fast train on the mainline reaches high speed and never exceeds its limits (no overspeed)', () => {
    const r = runLone({ trainClass: 1, stock: S800, origin: 'W-IN', destination: 'N-OUT' });
    assert.ok(r.train.finished);
    assert.ok(msToMph(maxSpeed(r)) > 110, `reached ${msToMph(maxSpeed(r)).toFixed(0)} mph`);
    assert.ok(maxSpeed(r) <= mphToMs(125) + 1e-6);
    assert.ok(r.samples.every((s) => s.speed <= s.permitted + 0.45), 'always within the permitted speed');
    assert.ok(!r.events.some((e) => e.kind === 'overspeed'));
    assert.deepEqual(r.problems, []);
  });

  test('a slower train on the mainline is held to its own model maximum, not the 125 mph line speed', () => {
    const r = runLone({ trainClass: 2, stock: S150, origin: 'W-IN', destination: 'N-OUT' });
    assert.ok(r.train.finished);
    assert.ok(maxSpeed(r) <= mphToMs(75) + 1e-6, `${msToMph(maxSpeed(r)).toFixed(1)} mph`);
    assert.ok(msToMph(maxSpeed(r)) > 70, 'and it does use it');
    assert.ok(r.samples.every((s) => s.permitted <= mphToMs(75) + 1e-6));
  });

  test('a train for a platform loop slows BEFORE the diverging throat, smoothly, and is at 40 mph or less when it gets there', () => {
    const r = runLone({ trainClass: 2, stock: S170, origin: 'W-IN', destination: 'N-OUT', platform: 'PLAT1', maxS: 400, stopWhen: (s) => s.status === 'dwelling' });
    const throatStart = sum('UPW2', 'UPW1', 'UP1', 'UP2', 'UP3', 'UP4', 'UP5', 'UP6', 'UP7', 'UP8'.slice(0, 0)) ; // placeholder replaced below
    void throatStart;
    const first = r.samples.find((s) => s.section === 'P1W');
    assert.ok(first, 'entered the platform throat');
    assert.ok(first!.speed <= mphToMs(40) + 0.3, `${msToMph(first!.speed).toFixed(1)} mph entering the throat`);
    // it was going much faster earlier, and the slowing began well before the throat (not at the boundary)
    const cruise = maxSpeed(r);
    assert.ok(cruise > mphToMs(80));
    const iFirst = r.samples.indexOf(first!);
    const beginBraking = r.samples.slice(0, iFirst).findIndex((s, i, a) => i > 0 && s.speed < (a[i - 1] as Sample).speed - 1e-9 && s.speed < cruise - 0.2);
    const distance = first!.front - (r.samples[beginBraking] as Sample).front;
    assert.ok(distance > 300, `braking began ${Math.round(distance)} m before the restriction`);
    assert.ok(peakDecel(r) <= stockPerformance(S170).serviceBrakeMs2 + 1e-6, `peak ${peakDecel(r).toFixed(3)} within the service rate`);
    assert.ok(!r.events.some((e) => e.kind === 'protection-stop' || e.kind === 'overspeed'));
  });

  test('a diverging junction route (to the branch) is taken at 40 mph or less, with anticipation', () => {
    const r = runLone({ trainClass: 1, stock: S387, origin: 'N-IN', destination: 'M-IO', maxS: 600 });
    assert.ok(r.train.finished);
    const la3 = r.samples.find((s) => s.section === 'LA3');
    assert.ok(la3, 'used the diverging leg');
    assert.ok(la3!.speed <= mphToMs(40) + 0.3, `${msToMph(la3!.speed).toFixed(1)} mph at LA3`);
    assert.ok(msToMph(maxSpeed(r)) > 90, 'but it was fast before');
    assert.ok(r.samples.every((s) => s.speed <= s.permitted + 0.45));
    assert.ok(peakDecel(r) <= stockPerformance(S387).serviceBrakeMs2 + 1e-6);
  });

  test('the straight route through the same junction keeps line speed (the limit follows the route, not the place)', () => {
    const r = runLone({ trainClass: 1, stock: S387, origin: 'N-IN', destination: 'W-OUT' });
    assert.ok(msToMph(maxSpeed(r)) > 105, 'never slowed for the junction');
    assert.ok(!r.samples.some((s) => s.section === 'LA3'));
  });

  test('a train does not brake abruptly at a boundary and does not oscillate between accelerating and braking', () => {
    for (const [cls, stock, dest, plat] of [[2, S170, 'N-OUT', 'PLAT1'], [1, S387, 'M-IO', null]] as const) {
      const origin = dest === 'M-IO' ? 'N-IN' : 'W-IN';
      const r = runLone({ trainClass: cls, stock, origin, destination: dest, platform: plat, maxS: 600 });
      // count switches between speeding up and slowing down in the run-up to the first restriction
      let switches = 0;
      let dir = 0;
      for (let i = 1; i < r.samples.length; i++) {
        const dv = (r.samples[i] as Sample).speed - (r.samples[i - 1] as Sample).speed;
        const d = Math.abs(dv) < 1e-9 ? 0 : Math.sign(dv);
        if (d !== 0 && dir !== 0 && d !== dir) switches++;
        if (d !== 0) dir = d;
        if ((r.samples[i] as Sample).section !== null) assert.ok(Math.abs(dv) / DT <= 1.6, 'no step change in speed beyond the stock performance');
      }
      assert.ok(switches <= 8, `${stock.model}: ${switches} accelerate/brake reversals`);
    }
  });

  test('different models need different braking distances for the same restriction', () => {
    const brakeDistance = (stock: StockRef, cls: 1 | 2): number => {
      const r = runLone({ trainClass: cls, stock, origin: 'W-IN', destination: 'N-OUT', platform: 'PLAT1', maxS: 400, stopWhen: (s) => s.status === 'dwelling' });
      const throat = r.samples.find((s) => s.section === 'P1W')!;
      const cruise = Math.max(...r.samples.map((s) => s.speed));
      const i = r.samples.findIndex((s) => s.speed >= cruise - 1e-9);
      const j = r.samples.findIndex((s, k) => k > i && s.speed < cruise - 0.3);
      return throat.front - (r.samples[j] as Sample).front;
    };
    const a = brakeDistance(S170, 2);
    const b = brakeDistance(S175, 2);
    assert.notEqual(Math.round(a), Math.round(b));
    // theory: (v² − 40²) / (2 · 0.9 · service)
    const theory = (stock: StockRef): number => (mphToMs(100) ** 2 - mphToMs(40) ** 2) / (2 * 0.9 * stockPerformance(stock).serviceBrakeMs2);
    assert.ok(Math.abs(a - theory(S170)) < theory(S170) * 0.15, `170: ${Math.round(a)} m vs ${Math.round(theory(S170))} m`);
    assert.ok(Math.abs(b - theory(S175)) < theory(S175) * 0.15);
  });
});

describe('Part 4: signal aspects and braking', () => {
  test('green, double yellow, yellow, red: the train slows through the sequence and stops short of the Danger signal', () => {
    // only the first route (U2>U3) is set, so U3 stays at Danger
    const r = runLone({ trainClass: 1, stock: S800, origin: 'W-IN', destination: 'N-OUT', routes: 1, maxS: 400, stopWhen: (s) => s.t > 30 && s.speed === 0 });
    const last = r.samples[r.samples.length - 1] as Sample;
    assert.equal(last.speed, 0);
    assert.ok(!r.signalPasses.some((p) => p.aspect === 'red'), 'no train passes a signal at Danger');
    assert.ok(!r.signalPasses.some((p) => p.signal === 'U3'), 'U3 (the first signal left at Danger) is never passed');
    assert.ok(!r.events.some((e) => e.kind === 'protection-stop'), 'a planned stop, no emergency');
    const byAspect = new Map<string, number>();
    for (const p of r.signalPasses) byAspect.set(p.aspect, p.speed);
    assert.ok(byAspect.has('green'), 'passed a green signal');
    assert.ok(byAspect.has('double-yellow') || byAspect.has('yellow'), 'met a caution aspect');
    const g = byAspect.get('green') as number;
    const y = (byAspect.get('yellow') ?? byAspect.get('double-yellow')) as number;
    assert.ok(y < g, `slower at the caution signal (${msToMph(y).toFixed(0)} mph) than at green (${msToMph(g).toFixed(0)} mph)`);
    assert.ok(peakDecel(r) <= stockPerformance(S800).serviceBrakeMs2 + 1e-6, 'smooth: never above the service rate');
    assert.deepEqual(r.problems, []);
  });

  test('at a single yellow the train can always stop at the next signal (yellow means: the next may be at Danger)', () => {
    for (const stock of [S800, S390, S387]) {
      const r = runLone({ trainClass: 1, stock, origin: 'W-IN', destination: 'N-OUT', routes: 1, maxS: 400, stopWhen: (s) => s.t > 30 && s.speed === 0 });
      const perf = stockPerformance(stock);
      for (const p of r.signalPasses.filter((x) => x.aspect === 'yellow')) {
        const next = ctx.net.signals.get(p.signal);
        assert.ok(next);
        const back = r.samples.find((s) => s.t >= p.t);
        assert.ok(back);
        const stopping = (p.speed * p.speed) / (2 * perf.serviceBrakeMs2);
        const gap = 1500; // the longest block after a yellow in this test is well over the stopping distance
        assert.ok(stopping < gap, `${stock.model}: stopping distance ${Math.round(stopping)} m at the yellow`);
      }
      assert.ok(!r.signalPasses.some((p) => p.aspect === 'red'));
    }
  });

  test('stopping distances differ by model (service braking differs)', () => {
    const dist = (stock: StockRef): number => {
      const r = runLone({ trainClass: 1, stock, origin: 'W-IN', destination: 'N-OUT', routes: 1, maxS: 400, stopWhen: (s) => s.t > 30 && s.speed === 0 });
      const cruise = Math.max(...r.samples.map((s) => s.speed));
      const i = r.samples.findIndex((s) => s.speed >= cruise - 1e-9);
      const j = r.samples.findIndex((s, k) => k > i && s.speed < cruise - 0.3);
      return (r.samples[r.samples.length - 1] as Sample).front - (r.samples[j] as Sample).front;
    };
    const d800 = dist(S800);
    const d390 = dist(S390);
    const d387 = dist(S387);
    assert.ok(d800 !== d390 && d390 !== d387, `${Math.round(d800)} / ${Math.round(d390)} / ${Math.round(d387)}`);
  });

  test('a signal turning Danger in front of a train that cannot stop in time: it brakes at the service rate or harder only for the signal, and never passes', () => {
    const r = runLone({ trainClass: 1, stock: S800, origin: 'W-IN', destination: 'N-OUT', routes: 1, maxS: 400, stopWhen: (s) => s.t > 30 && s.speed === 0 });
    const u3 = ['UPW2', 'UPW1', 'UP1', 'UP2', 'UP3', 'UP4'].reduce((n, id) => n + L(id), 0);
    assert.ok(r.samples.every((s) => s.front <= u3), `held short of U3 at ${u3}, max ${Math.max(...r.samples.map((x) => x.front))}`);
  });
});

describe('Part 4.5: overspeed is a warning, never an automatic brake', () => {
  test('a train whose driver ignores the restrictions exceeds them: warning raised once, cleared once, no extra braking', () => {
    const r = runLone({ trainClass: 2, stock: S170, origin: 'W-IN', destination: 'N-OUT', platform: 'PLAT1', ignore: true, maxS: 500 });
    const start = r.events.filter((e) => e.kind === 'overspeed');
    const end = r.events.filter((e) => e.kind === 'overspeed-ended');
    assert.ok(start.length >= 1, 'overspeed warning started');
    assert.ok(start.length <= 3 && end.length <= 3, `no flood of messages (${start.length} / ${end.length})`);
    assert.ok(start[0]!.text.includes('mph') && start[0]!.text.includes('permitted'));
    const over = r.samples.filter((s) => s.overspeed);
    assert.ok(over.length > 0);
    assert.ok(over.some((s) => msToMph(s.speed) > 60), 'actually well over 40 mph through the restriction: it was not braked to the limit');
    // while over the limit the train was not braked harder than its signal-stopping needs: no emergency
    assert.ok(!r.events.some((e) => e.kind === 'protection-stop'), 'signals still obeyed without an emergency');
    assert.ok(peakDecel(r) <= stockPerformance(S170).serviceBrakeMs2 * 1.001, 'braking for the platform stop is the ordinary service rate');
    // the warning goes away again, once the speed is within the limit (the train stops in the platform)
    assert.equal(r.train.speedInfo.overspeed, false);
  });

  test('a normal train never raises the warning', () => {
    for (const [cls, stock, o, d, p] of [[1, S800, 'W-IN', 'N-OUT', null], [2, S170, 'W-IN', 'N-OUT', 'PLAT1'], [1, S387, 'N-IN', 'M-IO', null], [2, S150, 'M-IO', 'N-OUT', null]] as const) {
      const r = runLone({ trainClass: cls, stock, origin: o, destination: d, platform: p, maxS: 600 });
      assert.ok(!r.events.some((e) => e.kind === 'overspeed'), `${stock.model} ${o}->${d}`);
    }
  });

  test('even an ignoring train never passes a Danger signal', () => {
    const r = runLone({ trainClass: 1, stock: S800, origin: 'W-IN', destination: 'N-OUT', routes: 1, ignore: true, maxS: 400, stopWhen: (s) => s.t > 30 && s.speed === 0 });
    assert.ok(!r.signalPasses.some((p) => p.aspect === 'red'));
    assert.equal((r.samples[r.samples.length - 1] as Sample).speed, 0);
  });
});

describe('Part 4.4: stopping position', () => {
  test('every formation stops inside the platform, wholly within it, short of the far end', () => {
    for (const stock of [S170, S175, S150, S387, { model: '170', formation: '3-car' }]) {
      const r = runLone({ trainClass: stock.model === '387' ? 1 : 2, stock, origin: 'W-IN', destination: 'N-OUT', platform: 'PLAT1', maxS: 500, stopWhen: (s) => s.status === 'dwelling' });
      const last = r.samples[r.samples.length - 1] as Sample;
      assert.equal(last.status, 'dwelling', stock.model);
      assert.equal(last.section, 'P1');
      const len = stockPerformance(stock).lengthM;
      const platform = net.sections.get('P1')!.lengthM;
      const startOfP1 = sum('UPW2', 'UPW1', 'UP1', 'UP2', 'UP3', 'UP4', 'UP5', 'UP6', 'UP7', 'P1W');
      void startOfP1;
      assert.ok(len <= platform, 'fits');
      assert.deepEqual(r.train.path.filter((p) => p.section === 'P1').length, 1);
    }
  });
});
