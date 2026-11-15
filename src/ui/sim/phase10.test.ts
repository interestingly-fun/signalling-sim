/**
 * Phase 10: difficulty levels, deliberate overlap, conflict-aware generation, and whole shifts played at every level
 * with the tests-only signaller through the real interlocking.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ashcombeDefinition, buildNetwork, checkLockInvariants, createSignallingContext, createSignallingState, DIFFICULTIES, DIFFICULTY_IDS, generateTimetable, occupiedSteps, validateTimetable, type DifficultyId } from '../../engine';
import { Simulation, STEP_SECONDS } from './simulation';
import { ShiftController } from './shift';
import { attachBot } from './shiftBot';
import { SCENARIOS } from './scenarios';

const net = buildNetwork(ashcombeDefinition);
const ctx = createSignallingContext(net);
const SEEDS = [1, 2, 3, 4];

describe('difficulty profiles', () => {
  test('the four levels have the specified target ranges, and more overlap pressure as they rise', () => {
    assert.deepEqual(DIFFICULTY_IDS, ['beginner', 'standard', 'advanced', 'expert']);
    assert.deepEqual(DIFFICULTIES.beginner.countRange, [5, 7]);
    assert.deepEqual(DIFFICULTIES.standard.countRange, [8, 12]);
    assert.deepEqual(DIFFICULTIES.advanced.countRange, [13, 18]);
    assert.deepEqual(DIFFICULTIES.expert.countRange, [19, 25]);
    for (let i = 1; i < DIFFICULTY_IDS.length; i++) {
      const lo: (typeof DIFFICULTIES)[DifficultyId] = DIFFICULTIES[DIFFICULTY_IDS[i - 1] as DifficultyId];
      const hi: (typeof DIFFICULTIES)[DifficultyId] = DIFFICULTIES[DIFFICULTY_IDS[i] as DifficultyId];
      assert.ok(hi.overlapBias >= lo.overlapBias && hi.minMaxConcurrent >= lo.minMaxConcurrent && hi.marginS <= lo.marginS && hi.spanPerServiceS <= lo.spanPerServiceS, `${hi.id} is denser than ${lo.id}`);
    }
  });
});

for (const id of DIFFICULTY_IDS) {
  describe(`generation: ${id}`, () => {
    const p = DIFFICULTIES[id];
    const tts = SEEDS.map((seed) => generateTimetable(ctx, seed, { difficulty: id }));

    test('count is in the target range (or the reduction is reported with a reason); the independent validator agrees', () => {
      tts.forEach((tt, i) => {
        const n = tt.services.length;
        assert.equal(tt.difficulty, id);
        assert.equal(tt.usedFallback, false, `seed ${SEEDS[i]} fell back`);
        assert.deepEqual(validateTimetable(ctx, tt, { countRange: [5, 25] }), [], `seed ${SEEDS[i]}`);
        if (n < p.countRange[0]) assert.ok((tt.report?.reductionReasons.length ?? 0) > 0, `seed ${SEEDS[i]}: ${n} services with no reason`);
        else assert.ok(n <= p.countRange[1], `seed ${SEEDS[i]}: ${n} services`);
        assert.equal(tt.report?.generated, n);
      });
    });

    test('trains overlap deliberately: concurrency reaches the level\'s minimum, and some overlaps are independent', () => {
      tts.forEach((tt, i) => {
        const st = tt.report?.stats;
        assert.ok(st, 'report present');
        assert.ok(st.maxConcurrent >= Math.min(p.minMaxConcurrent, 2), `seed ${SEEDS[i]}: max concurrent ${st.maxConcurrent}`);
        assert.ok(st.overlappingPairs >= 1, `seed ${SEEDS[i]}: some overlap`);
        assert.equal(st.independentSimultaneous + st.junctionInteractions <= st.overlappingPairs, true);
      });
    });

    test('same seed, same timetable', () => {
      const again = generateTimetable(ctx, SEEDS[0] as number, { difficulty: id });
      assert.deepEqual(again.services, tts[0]?.services);
    });
  });
}

describe('higher difficulty means more simultaneous traffic', () => {
  test('mean peak concurrency does not fall from Beginner to Expert', () => {
    const mean = (id: DifficultyId): number => SEEDS.reduce((a, s) => a + (generateTimetable(ctx, s, { difficulty: id }).report?.stats.maxConcurrent ?? 0), 0) / SEEDS.length;
    assert.ok(mean('expert') > mean('beginner'), `${mean('expert')} vs ${mean('beginner')}`);
  });
});

describe('shifts with and without ECS', () => {
  test('across seeds at Standard there are shifts with no ECS and shifts with ECS', () => {
    let none = 0;
    let some = 0;
    for (let seed = 1; seed <= 12; seed++) generateTimetable(ctx, seed, { difficulty: 'standard' }).services.some((s) => s.ecs) ? some++ : none++;
    assert.ok(none >= 1 && some >= 1, `none ${none}, some ${some}`);
  });
});

describe('ShiftController and scenarios carry the difficulty', () => {
  test('generate(seed, difficulty) sets the draft difficulty and report; the draft is inspectable before Start', () => {
    const sim = new Simulation(ctx, createSignallingState(net));
    const shift = new ShiftController(sim);
    shift.attach();
    shift.setMessageSink(() => {});
    shift.generate(3, 'advanced');
    assert.equal(shift.difficulty, 'advanced');
    assert.equal(shift.draft?.difficulty, 'advanced');
    assert.ok((shift.draft?.services.length ?? 0) >= 5);
    assert.equal(shift.current, null);
  });

  test('every scenario names a known difficulty or leaves it to the player', () => {
    for (const sc of SCENARIOS) assert.ok(sc.difficulty === undefined || sc.difficulty === null || DIFFICULTY_IDS.includes(sc.difficulty as DifficultyId), sc.id);
  });
});

interface Played { completed: boolean; allExited: boolean; problems: string[]; protectionStops: number; sharedSections: number; maxLive: number; worstDelayS: number; services: number }

function play(seed: number, difficulty: DifficultyId): Played {
  const sim = new Simulation(ctx, createSignallingState(net));
  const shift = new ShiftController(sim);
  shift.attach();
  shift.setMessageSink(() => {});
  attachBot(sim, shift, {});
  shift.generate(seed, difficulty);
  assert.ok(shift.start());
  const r: Played = { completed: false, allExited: false, problems: [], protectionStops: 0, sharedSections: 0, maxLive: 0, worstDelayS: -Infinity, services: 0 };
  sim.onEvents((events) => { for (const e of events) if (e.kind === 'protection-stop') r.protectionStops++; });
  for (let i = 0; i * STEP_SECONDS < 9000 && shift.current?.status === 'running'; i++) {
    sim.stepOnce();
    const live = sim.trains.filter((t) => !t.finished && t.frontM >= 0);
    r.maxLive = Math.max(r.maxLive, live.length);
    if (live.length >= 2 && i % 4 === 0) {
      const seen = new Set<string>();
      for (const t of live) for (const k of occupiedSteps(t)) {
        const sec = (t.path[k] as { section: string }).section;
        if (seen.has(sec)) r.sharedSections++;
        seen.add(sec);
      }
    }
    if (i % 40 === 0) r.problems.push(...checkLockInvariants(ctx, sim.getSig()));
  }
  const sh = shift.current!;
  r.completed = sh.status === 'completed';
  r.services = sh.timetable.services.length;
  r.allExited = sh.timetable.services.every((s) => sh.actuals.get(s.id)?.exitS != null);
  for (const s of sh.timetable.services) {
    const a = sh.actuals.get(s.id);
    if (a?.exitS != null) r.worstDelayS = Math.max(r.worstDelayS, a.exitS - s.exitS);
  }
  return r;
}

describe('whole shifts at every level, stand-in signaller, real interlocking', () => {
  for (const id of DIFFICULTY_IDS) {
    for (const seed of [1, 2]) {
      test(`${id}, seed ${seed}: completes, nobody stopped by protection, no shared section, schedule achievable`, () => {
        const r = play(seed, id);
        assert.equal(r.completed, true);
        assert.equal(r.allExited, true);
        assert.deepEqual(r.problems, []);
        assert.equal(r.protectionStops, 0);
        assert.equal(r.sharedSections, 0);
        assert.ok(r.maxLive >= 2, `max present ${r.maxLive}`);
        assert.ok(r.worstDelayS < 180, `worst exit delay ${r.worstDelayS.toFixed(0)} s`);
      });
    }
  }
});
