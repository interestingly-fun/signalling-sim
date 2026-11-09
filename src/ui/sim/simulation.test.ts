import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ashcombeDefinition, buildNetwork, createSignallingContext, createSignallingState, requestRoute, type SignallingState, type TrainRequest } from '../../engine';
import { Simulation, STEP_SECONDS } from './simulation';

const net = buildNetwork(ashcombeDefinition);
const ctx = createSignallingContext(net);

function routed(): SignallingState {
  let s = createSignallingState(net);
  for (const [a, b] of [['D2', 'D3'], ['D3', 'D4']] as const) {
    const r = requestRoute(ctx, s, a, b);
    assert.ok(r.ok);
    s = r.state;
  }
  return s;
}
const EXPRESS: TrainRequest = { headcode: '1G42', trainClass: 1, origin: 'N-IN', destination: 'W-OUT' };
function started(): Simulation {
  const sim = new Simulation(ctx, routed());
  assert.ok(sim.create(EXPRESS).ok);
  assert.ok(sim.start());
  return sim;
}
function drive(sim: Simulation, seconds: number, fps: number): void {
  for (let i = 0; i < Math.round(seconds * fps); i++) sim.advance(1 / fps);
}

describe('Simulation (headless, as driven by animation frames)', () => {
  test('spawn, start, pause, resume, finish', () => {
    const sim = new Simulation(ctx, routed());
    assert.equal(sim.mode, 'no-train');
    assert.ok(sim.create(EXPRESS).ok);
    assert.equal(sim.mode, 'ready');
    assert.equal(sim.create(EXPRESS).ok, false, 'a headcode cannot be used twice');
    const waitingAt = sim.train?.frontM;
    assert.ok((waitingAt ?? 0) < 0, 'waits just outside the boundary');
    drive(sim, 5, 60);
    assert.equal(sim.train?.frontM, waitingAt, 'does not move before Start');
    sim.start();
    assert.equal(sim.mode, 'running');
    drive(sim, 5, 60);
    sim.pause();
    assert.equal(sim.mode, 'paused');
    const at = sim.train?.frontM;
    drive(sim, 5, 60);
    assert.equal(sim.train?.frontM, at, 'paused train does not move');
    sim.resume();
    drive(sim, 200, 60);
    assert.equal(sim.mode, 'finished');
    assert.equal(sim.view(), null);
    assert.equal(sim.views().length, 0, 'completed trains are not drawn');
  });

  test('the same N fixed steps give the same train at 30, 60 and 144 fps', () => {
    const out: string[] = [];
    for (const fps of [30, 60, 144]) {
      const sim = started();
      let guard = 0;
      while (sim.stepsRun < 1000 && guard++ < 100000) {
        if (sim.stepsRun + 40 >= 1000) sim.stepOnce();
        else sim.advance(1 / fps);
      }
      out.push(JSON.stringify([sim.train?.frontM, sim.train?.speedMs]));
    }
    assert.equal(out[0], out[1]);
    assert.equal(out[1], out[2]);
  });

  test('the drawn position is interpolated between steps: smooth at 144 fps, not stepping at 20 Hz', () => {
    const sim = started();
    drive(sim, 5, 144);
    let prev = sim.view()?.frontM ?? 0;
    let distinct = 0;
    for (let i = 0; i < 144; i++) {
      sim.advance(1 / 144);
      const f = sim.view()?.frontM ?? 0;
      assert.ok(f >= prev - 1e-9, 'never moves backwards on screen');
      if (f > prev + 1e-12) distinct++;
      prev = f;
    }
    assert.ok(distinct >= 140, `position changes on (almost) every frame (${distinct}/144)`);
    const v = sim.view();
    assert.ok(v && v.frontM <= (sim.train?.frontM ?? 0) + 1e-9 && v.frontM >= (sim.train?.frontM ?? 0) - 1.6);
  });

  test('simulation speed changes only how much simulated time passes, not the steps', () => {
    const a = started();
    const b = started();
    b.speedFactor = 4;
    drive(a, 20, 60);
    drive(b, 5, 60);
    assert.ok(Math.abs(a.stepsRun - b.stepsRun) <= 2);
    assert.ok(Math.abs((a.train?.frontM ?? 0) - (b.train?.frontM ?? 0)) < 3);
  });

  test('reset removes the train, its occupancy and the routes it held; operator routes remain', () => {
    const sim = started();
    drive(sim, 25, 60); // past D1, so the automatic movement D1>D2 is locked by the train
    assert.ok(Object.values(sim.getSig().network.sectionOccupancy).some((o) => o === 'T1'));
    assert.ok(Object.keys(sim.getSig().residual).length > 0, 'the train holds a route it has passed');
    sim.reset();
    assert.equal(sim.mode, 'no-train');
    assert.ok(Object.values(sim.getSig().network.sectionOccupancy).every((o) => o === null));
    assert.equal(sim.getSig().routes['D1'], undefined);
    assert.equal(sim.getSig().routes['D3'], 'D3>D4', 'a route the train had not yet passed is untouched');
    assert.deepEqual(sim.getSig().residual, {}, 'nothing left partly locked');
    assert.ok(sim.create(EXPRESS).ok, 'a new train can be created');
  });

  test('an eastbound train enters at Westford on the UP main', () => {
    const sim = new Simulation(ctx, createSignallingState(net));
    assert.ok(sim.create({ headcode: '1E01', trainClass: 1, origin: 'W-IN', destination: 'N-OUT' }).ok);
    assert.equal(sim.train?.path[0]?.section, 'UPW2');
  });

  test('pause freezes every train AND the dwell timer; the speed multiplier scales the dwell consistently', () => {
    const sim = new Simulation(ctx, routed());
    for (const [a, b] of [['D2', 'P2W']] as const) {
      const r = requestRoute(ctx, createSignallingState(net), a, b);
      assert.ok(r.ok);
      sim.setSig(r.state);
    }
    assert.ok(sim.create({ headcode: '2A01', trainClass: 2, origin: 'N-IN', destination: 'W-OUT', platform: 'PLAT2', dwellS: 60 }).ok);
    assert.ok(sim.create({ headcode: '5A02', trainClass: 5, origin: 'W-IN', destination: 'N-OUT' }).ok);
    assert.equal(sim.startAll(), 2);
    let guard = 0;
    while (sim.trains.find((t) => t.spec.headcode === '2A01')?.stop?.phase !== 'dwelling' && guard++ < 20000) sim.advance(1 / 60);
    const dwelling = () => sim.trains.find((t) => t.spec.headcode === '2A01')!;
    assert.equal(dwelling().status, 'dwelling');
    sim.pause();
    const snap = JSON.stringify(sim.trains.map((t) => [t.frontM, t.speedMs, t.stop?.remainingS]));
    drive(sim, 10, 60);
    assert.equal(JSON.stringify(sim.trains.map((t) => [t.frontM, t.speedMs, t.stop?.remainingS])), snap, 'nothing changes while paused');
    sim.resume();
    const r0 = dwelling().stop?.remainingS ?? 0;
    drive(sim, 5, 60);
    const r1 = dwelling().stop?.remainingS ?? 0;
    assert.ok(Math.abs(r0 - r1 - 5) < 0.2, `1x: ${(r0 - r1).toFixed(2)} s elapsed in 5 s`);
    sim.speedFactor = 4;
    drive(sim, 5, 60);
    const r2 = dwelling().stop?.remainingS ?? 0;
    assert.ok(Math.abs(r1 - r2 - 20) < 0.5, `4x: ${(r1 - r2).toFixed(2)} s elapsed in 5 s`);
  });

  test('an unentered train can be removed; one that has entered cannot', () => {
    const sim = new Simulation(ctx, createSignallingState(net));
    assert.ok(sim.create(EXPRESS).ok);
    const id = sim.train!.id;
    assert.ok(sim.remove(id));
    assert.equal(sim.trains.length, 0);
    assert.ok(sim.create(EXPRESS).ok);
    sim.startAll();
    drive(sim, 10, 60);
    assert.ok((sim.train?.frontM ?? 0) > 0);
    assert.equal(sim.remove(sim.train!.id), false);
  });

  test('step size is the documented 20 Hz', () => assert.equal(STEP_SECONDS, 0.05));
});
