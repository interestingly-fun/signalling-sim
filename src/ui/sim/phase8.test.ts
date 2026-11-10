import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ashcombeDefinition, buildNetwork, checkLockInvariants, concurrencyStats, createSignallingContext, createSignallingState, frontSection, occupiedSteps, type Train } from '../../engine';
import { Simulation, STEP_SECONDS } from './simulation';
import { ShiftController } from './shift';
import { attachBot } from './shiftBot';

const net = buildNetwork(ashcombeDefinition);
const ctx = createSignallingContext(net);

interface Result {
  maxLive: number;
  multiS: number;
  threeS: number;
  completed: boolean;
  problems: string[];
  protectionStops: number;
  overspeeds: number;
  maxExitDelayS: number;
  seen: { upDown: boolean; platformMain: boolean; branchMain: boolean; entryWhileOther: boolean };
  sharedSections: number;
  clock: number;
  services: number;
  allExited: boolean;
}

/** A whole shift, headless, with the stand-in signaller; observes what is really in the area at each step. */
function runShift(seed: number): Result {
  const sim = new Simulation(ctx, createSignallingState(net));
  const shift = new ShiftController(sim);
  shift.attach();
  shift.setMessageSink(() => {});
  attachBot(sim, shift, {});
  shift.generate(seed);
  assert.ok(shift.start());
  const r: Result = { maxLive: 0, multiS: 0, threeS: 0, completed: false, problems: [], protectionStops: 0, overspeeds: 0, maxExitDelayS: -Infinity, seen: { upDown: false, platformMain: false, branchMain: false, entryWhileOther: false }, sharedSections: 0, clock: 0, services: 0, allExited: false };
  sim.onEvents((events) => {
    for (const e of events) {
      if (e.kind === 'protection-stop') r.protectionStops++;
      if (e.kind === 'overspeed') r.overspeeds++;
    }
  });
  const lines = (t: Train): Set<string> => new Set(occupiedSteps(t).map((k) => net.sections.get((t.path[k] as { section: string }).section)?.line ?? ''));
  let seenLive = 0;
  for (let i = 0; i * STEP_SECONDS < 7000 && shift.current?.status === 'running'; i++) {
    sim.stepOnce();
    const live = sim.trains.filter((t) => !t.finished && t.frontM >= 0);
    if (live.length > seenLive && seenLive >= 1) r.seen.entryWhileOther = true;
    seenLive = live.length;
    r.maxLive = Math.max(r.maxLive, live.length);
    if (live.length >= 2) r.multiS += STEP_SECONDS;
    if (live.length >= 3) r.threeS += STEP_SECONDS;
    if (live.length >= 2) {
      const ls = live.map(lines);
      const has = (k: string): number => ls.filter((s) => s.has(k)).length;
      if (has('UP') >= 1 && has('DOWN') >= 1) r.seen.upDown = true;
      if (has('PLATFORM') >= 1 && live.length - has('PLATFORM') >= 1 && ls.some((s) => s.has('UP') || s.has('DOWN')) && ls.some((s) => !s.has('PLATFORM') && (s.has('UP') || s.has('DOWN')))) r.seen.platformMain = true;
      if (has('BRANCH') >= 1 && ls.some((s) => !s.has('BRANCH') && (s.has('UP') || s.has('DOWN')))) r.seen.branchMain = true;
      // two trains never share a section
      const seen = new Set<string>();
      for (const t of live) for (const k of occupiedSteps(t)) {
        const sec = (t.path[k] as { section: string }).section;
        if (seen.has(sec)) r.sharedSections++;
        seen.add(sec);
      }
    }
    if (i % 20 === 0) r.problems.push(...checkLockInvariants(ctx, sim.getSig()));
  }
  const sh = shift.current!;
  r.completed = sh.status === 'completed';
  r.clock = sim.clockS;
  r.services = sh.timetable.services.length;
  r.allExited = sh.timetable.services.every((s) => sh.actuals.get(s.id)?.exitS != null);
  for (const s of sh.timetable.services) {
    const a = sh.actuals.get(s.id);
    if (a?.exitS != null) r.maxExitDelayS = Math.max(r.maxExitDelayS, a.exitS - s.exitS);
  }
  void frontSection;
  return r;
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 23, 34];
const results = new Map<number, Result>();
const res = (seed: number): Result => results.get(seed) ?? (results.set(seed, runShift(seed)), results.get(seed) as Result);

describe('Phase 8: concurrent traffic in real shifts (stand-in signaller, real interlocking)', () => {
  test('every shift completes with every train out, no lock violation, no emergency stop, no overspeed', () => {
    for (const seed of SEEDS) {
      const r = res(seed);
      assert.equal(r.completed, true, `seed ${seed}`);
      assert.equal(r.allExited, true, `seed ${seed}: every service left`);
      assert.deepEqual(r.problems, [], `seed ${seed}`);
      assert.equal(r.protectionStops, 0, `seed ${seed}: no emergency stops`);
      assert.equal(r.overspeeds, 0, `seed ${seed}: normal running raises no overspeed`);
      assert.equal(r.sharedSections, 0, `seed ${seed}: no two trains in one section`);
    }
  });

  test('trains really are in the area together: every shift has two at once, several have three or more', () => {
    for (const seed of SEEDS) assert.ok(res(seed).maxLive >= 2, `seed ${seed}: at most ${res(seed).maxLive} trains at once`);
    assert.ok(SEEDS.filter((s) => res(s).maxLive >= 3).length >= 4, 'some shifts have three or more');
    for (const seed of SEEDS) assert.ok(res(seed).multiS > 30, `seed ${seed}: ${res(seed).multiS.toFixed(0)} s with two or more present`);
  });

  test('independent movements overlap: UP with DOWN, platform loop with the mainline, branch with the mainline, and entry while others are in the area', () => {
    const any = (k: keyof Result['seen']): boolean => SEEDS.some((s) => res(s).seen[k]);
    assert.ok(any('upDown'), 'an UP and a DOWN train together');
    assert.ok(any('platformMain'), 'a platform train with independent main-line traffic');
    assert.ok(any('branchMain'), 'a branch train with main-line traffic');
    assert.ok(any('entryWhileOther'), 'a train entered while another was in the area');
  });

  test('conflicts are resolved by waiting, not by collisions: delays stay small and no train is discarded', () => {
    for (const seed of SEEDS) {
      const r = res(seed);
      assert.ok(r.maxExitDelayS < 180, `seed ${seed}: worst exit delay ${r.maxExitDelayS.toFixed(0)} s`);
    }
  });

  test('the generated timetable and what really happened agree about concurrency', () => {
    for (const seed of [1, 5, 23]) {
      const sim = new Simulation(ctx, createSignallingContext(net) && createSignallingState(net));
      const shift = new ShiftController(sim);
      shift.attach();
      shift.generate(seed);
      const planned = concurrencyStats(shift.draft!.services).maxPresent;
      assert.ok(planned >= 2);
      assert.ok(res(seed).maxLive >= Math.min(planned, 2));
    }
  });
});

describe('Phase 8: entry behaviour', () => {
  test('a train whose entry section is occupied waits outside; it is not discarded and enters once the line is clear', () => {
    const sim = new Simulation(ctx, createSignallingState(net));
    const shift = new ShiftController(sim);
    shift.attach();
    shift.setMessageSink(() => {});
    attachBot(sim, shift, {});
    shift.generate(1);
    shift.start();
    const first = shift.current!.timetable.services[0]!;
    // someone else (a test marker) occupies the first train's entry section for a while
    const entrySection = ctx.route(first.manual[0] ?? '')?.from;
    void entrySection;
    let held = false;
    let entered = false;
    for (let i = 0; i * STEP_SECONDS < 4000 && shift.current?.status === 'running'; i++) {
      if (!held && sim.clockS >= first.entryS - 5) {
        const t = sim.trains.find((x) => x.spec.headcode === first.headcode);
        if (t) {
          const sec = t.path[0]?.section as string;
          sim.setSig({ ...sim.getSig(), network: { ...sim.getSig().network, sectionOccupancy: { ...sim.getSig().network.sectionOccupancy, [sec]: 'BLOCK' } } });
          held = true;
        }
      }
      if (held && !entered && sim.clockS >= first.entryS + 120) {
        const sec = sim.trains.find((x) => x.spec.headcode === first.headcode)!.path[0]?.section as string;
        const t = sim.trains.find((x) => x.spec.headcode === first.headcode)!;
        assert.ok(t.frontM < 0, 'still waiting outside the boundary');
        sim.setSig({ ...sim.getSig(), network: { ...sim.getSig().network, sectionOccupancy: { ...sim.getSig().network.sectionOccupancy, [sec]: null } } });
        entered = true;
      }
      sim.stepOnce();
    }
    assert.ok(held && entered);
    assert.equal(shift.current!.status, 'completed');
    assert.ok(shift.current!.actuals.get(first.id)!.exitS !== null, 'the delayed train was not discarded');
    assert.ok(shift.current!.actuals.get(first.id)!.entryS! > first.entryS + 100, 'it entered late, after the line cleared');
  });
});
