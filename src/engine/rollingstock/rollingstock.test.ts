import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLLING_STOCK,
  accelerationAt,
  allStock,
  defaultStock,
  getFormation,
  getModel,
  isFlexibleClass1,
  modelAllowsClass,
  modelsForClass,
  msToMph,
  stockPerformance,
  stockProblem,
  validateRollingStock,
  type ModelDef,
} from '../index';

const SPEC: Record<string, { formations: string[]; classes: number[]; mph: number }> = {
  '800': { formations: ['5-car', '9-car'], classes: [1, 5], mph: 125 },
  '221': { formations: ['4-car', '5-car'], classes: [1, 5], mph: 125 },
  '390': { formations: ['9-car', '11-car'], classes: [1, 5], mph: 125 },
  '142': { formations: ['2-car'], classes: [2, 5], mph: 75 },
  '150': { formations: ['2-car', '3-car'], classes: [2, 5], mph: 75 },
  '170': { formations: ['2-car', '3-car'], classes: [2, 5], mph: 100 },
  '175': { formations: ['2-car', '3-car'], classes: [2, 5], mph: 100 },
  '387': { formations: ['4-car'], classes: [1, 2, 5], mph: 110 },
  '350': { formations: ['4-car'], classes: [1, 2, 5], mph: 110 },
};

describe('rolling-stock database', () => {
  test('every listed model exists with exactly the listed formations and top speed', () => {
    assert.equal(ROLLING_STOCK.length, Object.keys(SPEC).length);
    for (const [id, want] of Object.entries(SPEC)) {
      const m = getModel(id);
      assert.ok(m, `model ${id}`);
      assert.deepEqual(m.formations.map((f) => f.id), want.formations, id);
      assert.equal(m.maxSpeedMph, want.mph, id);
    }
  });

  test('the database is internally consistent (lengths, speeds, rates, longer formations slower)', () => {
    assert.deepEqual(validateRollingStock(), []);
  });

  test('the consistency check really does catch bad data', () => {
    const base = getModel('150') as ModelDef;
    const broken: ModelDef = { ...base, formations: [...base.formations, { ...(base.formations[1] as ModelDef['formations'][number]), id: '4-car', cars: 4, lengthM: 20, accelerationMs2: 2.5 }] };
    const problems = validateRollingStock([broken]);
    assert.ok(problems.some((p) => /implausible length/.test(p)));
    assert.ok(problems.some((p) => /implausible acceleration/.test(p)));
    assert.ok(problems.some((p) => /longer formation/.test(p)));
  });

  test('permitted operating classes: Class 1 only models, Class 2 only models, 387/350 either; every model may work Class 5', () => {
    for (const [id, want] of Object.entries(SPEC)) {
      for (const c of [1, 2, 5]) assert.equal(modelAllowsClass(id, c), want.classes.includes(c), `${id} as class ${c}`);
    }
    assert.equal(modelsForClass(5).length, ROLLING_STOCK.length, 'Class 5 can use every listed model');
    assert.deepEqual(modelsForClass(1).map((m) => m.id).sort(), ['221', '350', '387', '390', '800']);
    assert.deepEqual(modelsForClass(2).map((m) => m.id).sort(), ['142', '150', '170', '175', '350', '387']);
  });

  test('model/class/formation validation explains itself', () => {
    assert.equal(stockProblem(1, { model: '800', formation: '5-car' }), null);
    assert.match(stockProblem(2, { model: '800', formation: '5-car' }) as string, /cannot work as Class 2/);
    assert.match(stockProblem(1, { model: '150', formation: '2-car' }) as string, /cannot work as Class 1/);
    assert.match(stockProblem(2, { model: '170', formation: '9-car' }) as string, /no 9-car formation/);
    assert.match(stockProblem(2, { model: '999', formation: '2-car' }) as string, /Unknown train model/);
    for (const s of allStock()) assert.equal(stockProblem(5, s), null, `${s.model} ${s.formation} as Class 5`);
  });

  test('only 387 and 350 are flexible Class 1', () => {
    assert.deepEqual(ROLLING_STOCK.filter((m) => isFlexibleClass1(m.id)).map((m) => m.id).sort(), ['350', '387']);
  });

  test('defaults are valid for every class', () => {
    for (const c of [1, 2, 5]) assert.equal(stockProblem(c, defaultStock(c)), null);
  });
});

describe('physical characteristics', () => {
  test('models and formations differ meaningfully', () => {
    const acc = new Set(allStock().map((s) => stockPerformance(s).accelerationMs2));
    const brk = new Set(allStock().map((s) => stockPerformance(s).serviceBrakeMs2));
    assert.ok(acc.size >= 12, `${acc.size} distinct acceleration values`);
    assert.ok(brk.size >= 9, `${brk.size} distinct braking values`);
    const emu = stockPerformance({ model: '387', formation: '4-car' });
    const dmu = stockPerformance({ model: '221', formation: '5-car' });
    assert.ok(emu.accelerationMs2 > dmu.accelerationMs2 * 1.5);
    assert.ok(emu.serviceBrakeMs2 > dmu.serviceBrakeMs2);
  });

  test('a longer formation of the same model is longer, accelerates no faster and brakes no harder', () => {
    for (const m of ROLLING_STOCK) {
      const fs = [...m.formations].sort((a, b) => a.cars - b.cars);
      for (let i = 1; i < fs.length; i++) {
        const a = fs[i - 1]!;
        const b = fs[i]!;
        assert.ok(b.lengthM > a.lengthM && b.accelerationMs2 < a.accelerationMs2 && b.serviceBrakeMs2 < a.serviceBrakeMs2, `${m.name} ${a.id} vs ${b.id}`);
      }
    }
  });

  test('lengths are the longest 11-car 390 (263 m) down to the 31 m railbus, and every one fits a platform (310 m)', () => {
    const lengths = allStock().map((s) => stockPerformance(s).lengthM);
    assert.equal(Math.max(...lengths), 263);
    assert.equal(Math.min(...lengths), 31);
    assert.ok(lengths.every((l) => l <= 300));
  });

  test('top speeds convert to metres per second at the stated mph', () => {
    for (const s of allStock()) assert.ok(Math.abs(msToMph(stockPerformance(s).maxSpeedMs) - (getModel(s.model) as ModelDef).maxSpeedMph) < 1e-9);
  });

  test('acceleration falls smoothly from the standing rate to the taper share at top speed', () => {
    const spec = { ...stockPerformance({ model: '800', formation: '5-car' }) };
    assert.equal(accelerationAt(spec, 0), spec.accelerationMs2);
    assert.ok(Math.abs(accelerationAt(spec, spec.maxSpeedMs) - spec.accelerationMs2 * spec.accelTaper) < 1e-12);
    let prev = Infinity;
    for (let v = 0; v <= spec.maxSpeedMs; v += 1) {
      const a = accelerationAt(spec, v);
      assert.ok(a <= prev && a > 0);
      prev = a;
    }
    assert.equal(accelerationAt({ ...spec, accelTaper: undefined }, 20), spec.accelerationMs2, 'no taper: constant');
    assert.ok(getFormation('800', '5-car'));
  });
});
