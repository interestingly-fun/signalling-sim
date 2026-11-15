/**
 * Phase 9 through the whole application stack (simulation + shift controller + tests-only signaller):
 * generated shifts that contain ECS siding cycles are played to the end.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ashcombeDefinition, buildNetwork, checkLockInvariants, createSignallingContext, createSignallingState, generateTimetable, occupiedSteps, type EcsEventKind, type Timetable } from '../../engine';
import { computeAspects } from '../../engine';
import { clickBuffer, clickSignal, emptyRouteUi } from '../routeUi';
import { Simulation, STEP_SECONDS } from './simulation';
import { ShiftController } from './shift';
import { attachBot } from './shiftBot';

const net = buildNetwork(ashcombeDefinition);
const ctx = createSignallingContext(net);

describe('generated timetables with ECS siding cycles', () => {
  const seeds: number[] = [];
  const kinds = { sidings: new Set<string>(), origins: new Set<string>(), destinations: new Set<string>(), bays: new Set<string>(), onwardClasses: new Set<number>(), none: 0, both: 0 };
  for (let seed = 1; seed <= 30; seed++) {
    const tt = generateTimetable(ctx, seed, { difficulty: 'standard' });
    const e = tt.services.filter((s) => s.ecs);
    if (e.length === 0) kinds.none++;
    if (new Set(e.map((s) => s.ecs?.siding)).size === 2) kinds.both++;
    for (const s of e) {
      kinds.sidings.add(s.ecs?.siding ?? '');
      kinds.origins.add(s.origin);
      kinds.destinations.add(s.destination);
      kinds.onwardClasses.add(s.ecs?.onward.trainClass ?? 0);
      for (const b of [...(s.ecs?.approachBays ?? []), ...(s.ecs?.departureBays ?? [])]) kinds.bays.add(b);
    }
    if (e.length > 0 && seeds.length < 4) seeds.push(seed);
  }

  test('shifts vary: some have no ECS, some use both sidings; entries, exits, sidings, bays and onward classes all vary', () => {
    assert.ok(kinds.none >= 1, 'some shifts have no ECS cycle');
    assert.ok(kinds.both >= 1, 'some shifts use both sidings');
    assert.equal(kinds.sidings.size, 2);
    assert.ok(kinds.origins.size >= 3, `entries: ${[...kinds.origins]}`);
    assert.ok(kinds.destinations.size >= 3, `exits: ${[...kinds.destinations]}`);
    assert.ok(kinds.bays.size >= 2, `bays: ${[...kinds.bays]}`);
    assert.ok(kinds.onwardClasses.size >= 2, `onward classes: ${[...kinds.onwardClasses]}`);
  });

  for (const seed of seeds) {
    test(`seed ${seed}: the whole shift is played to completion`, () => {
      const sim = new Simulation(ctx, createSignallingState(net));
      const shift = new ShiftController(sim);
      shift.attach();
      shift.setMessageSink(() => {});
      attachBot(sim, shift, {});
      shift.generate(seed, 'standard');
      const tt = shift.draft as Timetable;
      assert.ok(shift.start());
      const ecsEvents: EcsEventKind[] = [];
      let protectionStops = 0;
      sim.onEvents((events) => {
        for (const e of events) {
          if (e.kind === 'protection-stop') protectionStops++;
          if (e.kind === 'ecs') ecsEvents.push(e.what);
        }
      });
      const problems: string[] = [];
      let shared = 0;
      for (let i = 0; i * STEP_SECONDS < 9000 && shift.current?.status === 'running'; i++) {
        sim.stepOnce();
        const live = sim.trains.filter((t) => !t.finished && t.frontM >= 0);
        const seen = new Set<string>();
        for (const t of live) for (const k of occupiedSteps(t)) {
          const sec = (t.path[k] as { section: string }).section;
          if (seen.has(sec)) shared++;
          seen.add(sec);
        }
        if (i % 40 === 0) problems.push(...checkLockInvariants(ctx, sim.getSig()));
      }
      const sh = shift.current!;
      assert.equal(sh.status, 'completed', `shift completed; clock ${sim.clockS}`);
      assert.deepEqual(problems, []);
      assert.equal(shared, 0, 'no two trains in one section');
      assert.equal(protectionStops, 0);
      for (const s of tt.services) {
        const a = sh.actuals.get(s.id);
        assert.ok(a?.exitS != null, `${s.headcode} exited`);
        if (s.ecs) {
          assert.ok(a?.arrivalS != null && a.readyS != null && a.departureS != null, `${s.headcode}: stabled, ready, left`);
          assert.ok((a?.departureS ?? 0) - (a?.arrivalS ?? 0) >= s.ecs.stablingS, 'stabled for at least the planned time');
        }
      }
      const n = tt.services.filter((s) => s.ecs).length;
      assert.equal(ecsEvents.filter((k) => k === 'stabled').length, n);
      assert.equal(ecsEvents.filter((k) => k === 'new-headcode').length, n);
      assert.equal(ecsEvents.filter((k) => k === 'siding-released').length, n);
    });
  }
});

describe('setting a route into a siding from the diagram', () => {
  test('AJ4 then the buffer stops of Siding 1 sets the route; AJ4 shows green; Siding 1 buffer from a signal with no route is refused', () => {
    const sig = createSignallingState(net);
    // buffer clicked first: told to choose the entrance
    const first = clickBuffer(ctx, sig, emptyRouteUi, 'SD1-BUF');
    assert.equal(first.state, undefined);
    assert.match(first.message?.text ?? '', /choose the entrance/);
    const a = clickSignal(ctx, sig, emptyRouteUi, 'S4');
    assert.equal(a.ui.entrance, 'S4');
    const b = clickBuffer(ctx, sig, a.ui, 'SD1-BUF');
    assert.ok(b.state, b.message?.text ?? 'no state');
    assert.equal(computeAspects(ctx, b.state as typeof sig)['S4'], 'green');
    // a signal with no route to that buffer
    const c = clickBuffer(ctx, sig, { entrance: 'U2', routeId: null }, 'SD1-BUF');
    assert.equal(c.state, undefined);
    assert.equal(c.message?.kind, 'error');
  });
});
