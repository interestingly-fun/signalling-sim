import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ashcombeDefinition, buildNetwork, createSignallingContext, generateTimetable, isFlexibleClass1, stockProblem, getFormation, platformFit, type Timetable } from '../index';

const net = buildNetwork(ashcombeDefinition);
const ctx = createSignallingContext(net);
const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);
const cache = new Map<number, Timetable>();
const tt = (seed: number): Timetable => cache.get(seed) ?? (cache.set(seed, generateTimetable(ctx, seed)), cache.get(seed)!);
const all = (): ReturnType<typeof tt>['services'][number][] => SEEDS.flatMap((s) => [...tt(s).services]);

describe('timetable rolling stock', () => {
  test('every service has a valid class/model/formation combination', () => {
    for (const s of all()) assert.equal(stockProblem(s.trainClass, { model: s.model, formation: s.formation }), null, `${s.headcode} ${s.model} ${s.formation}`);
  });

  test('every service fits the platform it uses, with its real length', () => {
    for (const s of all()) {
      if (s.platform) assert.ok(platformFit(net, s.platform, getFormation(s.model, s.formation)!.lengthM).ok, `${s.headcode} ${s.model}`);
    }
  });

  test('Class 1-only models never stop and never use the branch; flexible Class 1 may', () => {
    const flexStops = all().filter((s) => s.trainClass === 1 && isFlexibleClass1(s.model) && s.platform);
    for (const s of all()) {
      if (s.trainClass === 1 && !isFlexibleClass1(s.model)) assert.ok(!s.platform, `${s.headcode} ${s.model} must not stop`);
    }
    assert.ok(flexStops.length > 0, 'some 387/350 Class 1 services stop at Ashcombe');
  });

  test('a good spread of models appears, ECS is uncommon, and the shift size is unchanged', () => {
    const models = new Set(all().map((s) => s.model));
    for (const m of ['800', '221', '390', '142', '150', '170', '175', '387', '350']) assert.ok(models.has(m), `model ${m} appears`);
    const ecs = all().filter((s) => s.trainClass === 5).length;
    assert.ok(ecs < all().length * 0.3, `${ecs} ECS of ${all().length}`);
    for (const s of SEEDS) assert.ok(tt(s).services.length >= 5 && tt(s).services.length <= 7);
  });

  test('the same seed gives the same stock', () => {
    const a = generateTimetable(ctx, 5).services.map((s) => `${s.headcode}${s.model}${s.formation}`);
    const b = generateTimetable(ctx, 5).services.map((s) => `${s.headcode}${s.model}${s.formation}`);
    assert.deepEqual(a, b);
  });
});
