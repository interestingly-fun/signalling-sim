import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ashcombeDefinition,
  buildNetwork,
  checkLockInvariants,
  createSignallingContext,
  createSignallingState,
  createTrain,
  frontSection,
  getModel,
  journeyProfile,
  occupiedSteps,
  planServices,
  platformFit,
  rearSection,
  requestRoute,
  sensiblePlans,
  spawnTrain,
  stepFleet,
  stockPerformance,
  specForStock,
  type SignallingState,
  type StockRef,
  type Train,
} from '../index';

const net = buildNetwork(ashcombeDefinition);
const ctx = createSignallingContext(net);
const DT = 0.05;

interface Sample {
  t: number;
  front: number;
  rear: number;
  speed: number;
  occupied: string[];
  frontSec: string | null;
  rearSec: string | null;
  finished: boolean;
  exited: boolean;
  status: string;
}

interface RunOptions {
  trainClass: 1 | 2 | 5;
  stock: StockRef;
  origin: string;
  destination: string;
  platform?: string | null;
  /** Set only the first n manual routes (to leave a later signal at Danger). */
  routes?: number;
  maxS?: number;
  stopWhen?: (s: Sample) => boolean;
}

/** One train alone on the real engine, with the signaller setting routes as early as the interlocking allows. */
function runLone(o: RunOptions): { samples: Sample[]; train: Train; sig: SignallingState; problems: string[] } {
  let sig = createSignallingState(net);
  const platform = o.platform ?? null;
  const made = createTrain(ctx, sig, [], { headcode: `${o.trainClass}P00`, trainClass: o.trainClass, origin: o.origin, destination: o.destination, platform, dwellS: 30, model: o.stock.model, formation: o.stock.formation }, 'T1', { ignorePlatformAvailability: true });
  assert.ok(made.ok, made.ok ? '' : made.reason);
  sig = made.sig;
  let trains: Train[] = [{ ...made.train, started: true }];
  const manual = made.plan.manual.slice(0, o.routes ?? 99);
  const done = new Set<string>();
  const samples: Sample[] = [];
  const problems: string[] = [];
  for (let i = 0; i * DT < (o.maxS ?? 400); i++) {
    const tr = trains[0] as Train;
    for (const m of manual) {
      const r = ctx.route(m);
      if (!r || done.has(m) || sig.residual[m] || tr.heldRoutes.includes(m) || sig.routes[r.from] !== undefined) continue;
      const res = requestRoute(ctx, sig, r.from, r.to, m);
      if (res.ok) {
        sig = res.state;
        done.add(m);
      }
    }
    const step = stepFleet(ctx, sig, trains, DT);
    sig = step.sig;
    trains = [...step.trains];
    const t = trains[0] as Train;
    problems.push(...checkLockInvariants(ctx, sig));
    const s: Sample = {
      t: (i + 1) * DT,
      front: t.frontM,
      rear: t.frontM - t.spec.lengthM,
      speed: t.speedMs,
      occupied: t.finished ? [] : occupiedSteps(t).map((k) => t.path[k]!.section),
      frontSec: t.finished ? null : frontSection(t),
      rearSec: t.finished ? null : rearSection(t),
      finished: t.finished,
      exited: t.exited !== null,
      status: t.status,
    };
    samples.push(s);
    // the interlocking's record of occupancy must agree with the train's own geometry at every step
    const occ = Object.entries(sig.network.sectionOccupancy).filter(([, v]) => v === 'T1').map(([k]) => k).sort();
    assert.deepEqual(occ, [...s.occupied].sort(), `occupancy at t=${s.t.toFixed(2)}`);
    if (s.finished || o.stopWhen?.(s)) break;
  }
  return { samples, train: trains[0] as Train, sig, problems };
}

const S387: StockRef = { model: '387', formation: '4-car' };
const S142: StockRef = { model: '142', formation: '2-car' };
const S800_5: StockRef = { model: '800', formation: '5-car' };
const S390_11: StockRef = { model: '390', formation: '11-car' };
const S390_9: StockRef = { model: '390', formation: '9-car' };
const S221_5: StockRef = { model: '221', formation: '5-car' };

describe('train-specific acceleration', () => {
  test('different models accelerate differently from the same entry speed on the same track', () => {
    const at = (stock: StockRef, cls: 1 | 2): number => {
      const r = runLone({ trainClass: cls, stock, origin: 'W-IN', destination: 'N-OUT', maxS: 14, stopWhen: (s) => s.t >= 12 });
      return (r.samples.find((s) => s.t >= 12) ?? (r.samples[r.samples.length - 1] as Sample)).speed;
    };
    const emu = at(S387, 2);
    const dmu = at(S142, 2);
    assert.ok(emu > dmu + 2, `387 ${emu.toFixed(1)} m/s vs 142 ${dmu.toFixed(1)} m/s after 12 s`);
  });

  test('a longer formation of the same model accelerates more slowly', () => {
    const at = (stock: StockRef): number => {
      const r = runLone({ trainClass: 1, stock, origin: 'W-IN', destination: 'N-OUT', maxS: 14, stopWhen: (s) => s.t >= 12 });
      return (r.samples.find((s) => s.t >= 12) ?? (r.samples[r.samples.length - 1] as Sample)).speed;
    };
    assert.ok(at(S390_9) > at(S390_11), 'the 9-car is quicker than the 11-car');
    assert.ok(at({ model: '800', formation: '5-car' }) > at({ model: '800', formation: '9-car' }));
  });

  test('acceleration is smooth: speed never jumps, and is bounded by the model\'s own rate', () => {
    for (const stock of [S387, S142, S800_5, S390_11]) {
      const cls = stock.model === '142' ? 2 : 1;
      const r = runLone({ trainClass: cls, stock, origin: 'W-IN', destination: 'N-OUT', maxS: 60 });
      const perf = stockPerformance(stock);
      let prev = r.samples[0]!.speed;
      for (const s of r.samples) {
        const a = (s.speed - prev) / DT;
        assert.ok(a <= perf.accelerationMs2 + 1e-6, `${stock.model} accelerates at ${a.toFixed(3)} > ${perf.accelerationMs2}`);
        assert.ok(a >= -perf.emergencyBrakeMs2 - 1e-6, `${stock.model} decelerates at ${a.toFixed(3)}`);
        prev = s.speed;
      }
    }
  });
});

describe('train-specific braking', () => {
  /** Enters the area with only the first route set, so it must stop at the next signal (at Danger). */
  function stopAtDanger(stock: StockRef, cls: 1 | 2) {
    const r = runLone({ trainClass: cls, stock, origin: 'W-IN', destination: 'N-OUT', routes: 1, maxS: 200, stopWhen: (s) => s.t > 20 && s.speed === 0 });
    const last = r.samples[r.samples.length - 1] as Sample;
    assert.equal(last.speed, 0, `${stock.model} did not stop`);
    // peak deceleration while braking
    let peak = 0;
    // the last fraction of a m/s is snapped to standstill by the engine, so measure the braking proper
    for (let i = 1; i < r.samples.length; i++) if ((r.samples[i - 1] as Sample).speed > 0.5) peak = Math.max(peak, ((r.samples[i - 1] as Sample).speed - (r.samples[i] as Sample).speed) / DT);
    return { last, peak, r };
  }

  test('each model brakes at its own service rate and stops short of the Danger signal', () => {
    const results = [S387, S142, S221_5, S390_11].map((stock) => {
      const cls = stock.model === '142' ? 2 : 1;
      return { stock, ...stopAtDanger(stock, cls) };
    });
    for (const x of results) {
      const perf = stockPerformance(x.stock);
      assert.ok(x.peak <= perf.serviceBrakeMs2 * 1.05, `${x.stock.model} peak deceleration ${x.peak.toFixed(3)} above its service rate ${perf.serviceBrakeMs2}`);
      assert.ok(x.peak >= perf.serviceBrakeMs2 * 0.85, `${x.stock.model} braked too gently: ${x.peak.toFixed(3)}`);
      assert.ok(!x.r.samples.some((s) => s.status === 'stopped at signal' && s.speed > 0), 'no movement while stopped');
    }
    const [emu, , dmu] = results;
    assert.ok((emu as { peak: number }).peak > (dmu as { peak: number }).peak + 0.15, 'the EMU brakes much harder than the heavy DMU');
  });

  test('stopping never overruns the Danger signal, whatever the train', () => {
    for (const [stock, cls] of [[S387, 1], [S142, 2], [S800_5, 1], [S390_11, 1], [S221_5, 1]] as const) {
      const { r } = stopAtDanger(stock, cls);
      const sigStop = r.samples.filter((s) => s.speed === 0).pop() as Sample;
      assert.ok(sigStop.front <= (r.train.limit.limitM ?? Infinity) + 1e-6, `${stock.model}`);
      assert.deepEqual(r.problems, [], 'lock invariants held throughout');
    }
  });
});

describe('train length and occupancy', () => {
  test('a train occupies exactly the sections its front and rear span, at every step', () => {
    // runLone asserts the interlocking's occupancy equals the geometry at every step; run long and short trains.
    for (const [stock, cls] of [[S390_11, 1], [S800_5, 1], [S142, 2], [S387, 1]] as const) {
      const r = runLone({ trainClass: cls, stock, origin: 'W-IN', destination: 'N-OUT' });
      assert.ok(r.samples[r.samples.length - 1]!.finished, `${stock.model} finished`);
      assert.deepEqual(r.problems, []);
    }
  });

  test('the rear stays in a section until it has physically cleared it', () => {
    const r = runLone({ trainClass: 1, stock: S390_11, origin: 'W-IN', destination: 'N-OUT' });
    const length = stockPerformance(S390_11).lengthM;
    // find the first moment the front is in a later section than the rear: the train must span sections, for a while
    const spanning = r.samples.filter((s) => s.frontSec !== null && s.rearSec !== null && s.frontSec !== s.rearSec);
    assert.ok(spanning.length > 100, 'a 263 m train spans several sections for a long time');
    for (const s of r.samples) {
      if (s.frontSec && s.rearSec) assert.ok(s.occupied.includes(s.frontSec) && s.occupied.includes(s.rearSec), 'both the front and the rear sections are occupied');
      assert.ok(Math.abs(s.front - s.rear - length) < 1e-9, 'length is constant');
    }
  });

  test('longer trains take longer to clear the same sections and the same journey', () => {
    const plan = sensiblePlans(ctx, planServices(ctx, { trainClass: 1, origin: 'W-IN', destination: 'N-OUT', model: '390' }), null)[0]!;
    const short = journeyProfile(ctx, { trainClass: 1, stock: S390_9, plan, platform: null, dwellS: 0 })!;
    const long = journeyProfile(ctx, { trainClass: 1, stock: S390_11, plan, platform: null, dwellS: 0 })!;
    // pick a short section in the middle of the journey (a junction area): the long train holds it for longer
    let compared = 0;
    for (const sec of plan.path.map((p) => p.section)) {
      const a = short.sections[sec];
      const b = long.sections[sec];
      if (!a || !b) continue;
      assert.ok(b[1] - b[0] > a[1] - a[0], `section ${sec}: the long train should hold it longer (${(b[1] - b[0]).toFixed(1)} s vs ${(a[1] - a[0]).toFixed(1)} s)`);
      compared++;
    }
    assert.ok(compared >= 5);
  });

  test('route sections are released only once the rear has cleared them', () => {
    const r = runLone({ trainClass: 1, stock: S390_11, origin: 'W-IN', destination: 'N-OUT' });
    // runLone asserts, every step, that the train's occupancy matches the interlocking and that lock invariants hold.
    // Here: at no step is a section the rear still covers free of locks.
    let sig = createSignallingState(net);
    const made = createTrain(ctx, sig, [], { headcode: '1P01', trainClass: 1, origin: 'W-IN', destination: 'N-OUT', model: '390', formation: '11-car' }, 'T1');
    assert.ok(made.ok);
    sig = made.sig;
    let trains: Train[] = [{ ...made.train, started: true }];
    const done = new Set<string>();
    let checked = 0;
    for (let i = 0; i < 400 / DT; i++) {
      for (const m of made.plan.manual) {
        const rt = ctx.route(m)!;
        if (done.has(m) || sig.residual[m] || (trains[0] as Train).heldRoutes.includes(m) || sig.routes[rt.from] !== undefined) continue;
        const res = requestRoute(ctx, sig, rt.from, rt.to, m);
        if (res.ok) {
          sig = res.state;
          done.add(m);
        }
      }
      const step = stepFleet(ctx, sig, trains, DT);
      sig = step.sig;
      trains = [...step.trains];
      const t = trains[0] as Train;
      if (t.finished) break;
      for (const k of occupiedSteps(t)) {
        const sec = t.path[k]!.section;
        if (t.path[k]!.section === rearSection(t)) {
          assert.ok(sig.sectionLocks[sec] !== undefined || sig.network.sectionOccupancy[sec] === 'T1', `section ${sec} under the rear is neither locked nor occupied`);
          assert.equal(sig.network.sectionOccupancy[sec], 'T1');
          checked++;
        }
      }
    }
    assert.ok(checked > 200);
    assert.deepEqual(r.problems, []);
  });

  test('the train is not finished until its rear has cleared the exit boundary', () => {
    const r = runLone({ trainClass: 1, stock: S390_11, origin: 'W-IN', destination: 'N-OUT' });
    const exitedAt = r.samples.find((s) => s.exited)!;
    const finishedAt = r.samples.find((s) => s.finished)!;
    assert.ok(finishedAt.t > exitedAt.t + 2, `finished ${finishedAt.t.toFixed(1)} s, front out at ${exitedAt.t.toFixed(1)} s`);
    // between the two the rear is still inside and the last section is still occupied
    const mid = r.samples.find((s) => s.exited && !s.finished)!;
    assert.ok(mid.occupied.length > 0 && mid.rearSec !== null);
    assert.ok(finishedAt.occupied.length === 0);
    // the time between is about length / speed
    const speed = exitedAt.speed;
    assert.ok(Math.abs(finishedAt.t - exitedAt.t - 263 / speed) < 2, `${(finishedAt.t - exitedAt.t).toFixed(1)} s vs ${(263 / speed).toFixed(1)} s`);
  });

  test('every model/formation fits Platform 1 and Platform 2 (and a train that is too long is refused)', () => {
    for (const lengthM of [31, 130, 234, 263]) {
      assert.ok(platformFit(net, 'PLAT1', lengthM).ok && platformFit(net, 'PLAT2', lengthM).ok, `${lengthM} m`);
    }
    assert.equal(platformFit(net, 'PLAT1', 301).ok, false);
    const spec = specForStock(2, { model: '170', formation: '2-car' }, { headcode: '2X01', origin: 'W-IN', destination: 'N-OUT', lengthM: 400, stop: { platform: 'PLAT1', dwellS: 30 } });
    const sp = spawnTrain(net, createSignallingState(net), spec, 'T1', { id: 'T1', plan: [] });
    assert.equal(sp.ok, false);
  });

  test('a long train stopped at a platform is wholly inside it, and occupies only the platform section', () => {
    const r = runLone({ trainClass: 5, stock: S390_11, origin: 'W-IN', destination: 'N-OUT', platform: 'PLAT1', maxS: 400, stopWhen: (s) => s.status === 'dwelling' });
    const last = r.samples[r.samples.length - 1]!;
    assert.equal(last.status, 'dwelling');
    assert.equal(last.rearSec, 'P1', 'the 263 m train is entirely within the 310 m platform');
    assert.equal(last.frontSec, 'P1');
    assert.deepEqual(last.occupied, ['P1']);
  });
});

describe('operating-class rules with models', () => {
  const create = (cls: number, model: string, formation: string, origin: string, destination: string, platform: string | null = null) =>
    createTrain(ctx, createSignallingState(net), [], { headcode: `${cls}A01`, trainClass: cls, origin, destination, platform, dwellS: 30, model, formation }, 'T1');

  test('Class 1-only models cannot stop, cannot use the branch', () => {
    for (const [m, f] of [['800', '5-car'], ['221', '4-car'], ['390', '11-car']] as const) {
      assert.equal(create(1, m, f, 'W-IN', 'N-OUT').ok, true, `${m} runs through`);
      const stop = create(1, m, f, 'W-IN', 'N-OUT', 'PLAT1');
      assert.equal(stop.ok, false, `${m} must not stop`);
      assert.match(stop.ok ? '' : stop.reason, /never stop/);
      const branch = create(1, m, f, 'M-IO', 'N-OUT');
      assert.equal(branch.ok, false, `${m} must not use the branch`);
      assert.match(branch.ok ? '' : branch.reason, /never use the branch|No valid route/);
    }
  });

  test('Class 2-only models cannot be given Class 1, and can stop and use the branch', () => {
    for (const [m, f] of [['142', '2-car'], ['150', '3-car'], ['170', '2-car'], ['175', '3-car']] as const) {
      const asOne = create(1, m, f, 'W-IN', 'N-OUT');
      assert.equal(asOne.ok, false);
      assert.match(asOne.ok ? '' : asOne.reason, /cannot work as Class 1/);
      assert.equal(create(2, m, f, 'W-IN', 'N-OUT', 'PLAT1').ok, true, `${m} stops at Platform 1`);
      assert.equal(create(2, m, f, 'M-IO', 'N-OUT').ok, true, `${m} uses the branch`);
      assert.equal(create(2, m, f, 'N-IN', 'M-IO').ok, true, `${m} uses the branch (to Merefield)`);
    }
  });

  test('Class 800 cannot be Class 2; a wrong formation is refused', () => {
    const r = create(2, '800', '5-car', 'W-IN', 'N-OUT');
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.reason, /cannot work as Class 2/);
    const f = create(2, '170', '9-car', 'W-IN', 'N-OUT');
    assert.equal(f.ok, false);
    assert.match(f.ok ? '' : f.reason, /no 9-car formation/);
  });

  test('Class 387 and 350 work as Class 1 or Class 2, with the branch, and stop at Ashcombe as Class 1 when asked', () => {
    for (const m of ['387', '350']) {
      for (const cls of [1, 2]) {
        assert.equal(create(cls, m, '4-car', 'W-IN', 'N-OUT').ok, true, `${m} as class ${cls} runs through`);
        assert.equal(create(cls, m, '4-car', 'M-IO', 'N-OUT').ok, true, `${m} as class ${cls} uses the branch`);
        assert.equal(create(cls, m, '4-car', 'W-IN', 'N-OUT', 'PLAT1').ok, true, `${m} as class ${cls} stops at Platform 1`);
        assert.equal(create(cls, m, '4-car', 'N-IN', 'W-OUT', 'PLAT2').ok, true, `${m} as class ${cls} stops at Platform 2`);
      }
    }
  });

  test('a Class 1 387 that is timetabled to stop really stops at the platform, dwells and leaves', () => {
    const r = runLone({ trainClass: 1, stock: S387, origin: 'W-IN', destination: 'N-OUT', platform: 'PLAT1', maxS: 500 });
    const states = new Set(r.samples.map((s) => s.status));
    assert.ok(states.has('stopped at platform') || states.has('dwelling'));
    assert.ok(states.has('dwelling'));
    assert.ok(r.samples[r.samples.length - 1]!.finished);
    assert.deepEqual(r.problems, []);
  });

  test('a Class 1-only 800 runs the same route without stopping: its profile has a pass time and no arrival', () => {
    const plan = sensiblePlans(ctx, planServices(ctx, { trainClass: 1, origin: 'W-IN', destination: 'N-OUT', model: '800' }), null)[0]!;
    const p = journeyProfile(ctx, { trainClass: 1, stock: S800_5, plan, platform: null, dwellS: 0 })!;
    assert.equal(p.entryToArrivalS, null);
    assert.ok(p.entryToPassS !== null);
  });

  test('Class 5 ECS can be made up as any model and formation, and runs through (the mains and platforms)', () => {
    for (const model of ROLLING_STOCK_IDS) {
      for (const f of getModel(model)!.formations) {
        assert.equal(create(5, model, f.id, 'W-IN', 'N-OUT').ok, true, `${model} ${f.id} as Class 5 runs through`);
        assert.equal(create(5, model, f.id, 'N-IN', 'W-OUT', 'PLAT2').ok, true, `${model} ${f.id} as Class 5 stops`);
        assert.equal(create(5, model, f.id, 'M-IO', 'N-OUT').ok, false, `${model} ${f.id} as Class 5 keeps the existing no-branch rule`);
      }
    }
  });
});

const ROLLING_STOCK_IDS = ['800', '221', '390', '142', '150', '170', '175', '387', '350'];
