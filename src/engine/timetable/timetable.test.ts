import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultStock,
  isFlexibleClass1,
  stockPerformance,
  sensiblePlans,
  ashcombeDefinition,
  buildNetwork,
  classAllowsLine,
  clockText,
  createSignallingContext,
  currentDelayS,
  delayText,
  deriveStatus,
  emptyActual,
  fallbackTimetable,
  generateTimetable,
  stepsFrom,
  otherEnd,
  summarise,
  validateService,
  validateTimetable,
  conflictsBetween,
  planServices,
  buildService,
  journeyOptions,
  type ServiceActual,
  type ServiceSchedule,
  type Timetable,
} from '../index';

const net = buildNetwork(ashcombeDefinition);
const ctx = createSignallingContext(net);
const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);
const cache = new Map<number, Timetable>();
const tt = (seed: number): Timetable => {
  let t = cache.get(seed);
  if (!t) cache.set(seed, (t = generateTimetable(ctx, seed)));
  return t;
};

describe('timetable generation', () => {
  test('a shift has 5–7 services, across many seeds', () => {
    const counts = new Set<number>();
    for (const seed of SEEDS) {
      const n = tt(seed).services.length;
      assert.ok(n >= 5 && n <= 7, `seed ${seed}: ${n}`);
      counts.add(n);
    }
    assert.ok(counts.size >= 2, 'the number varies between shifts');
  });

  test('headcodes are valid British-style codes, unique, and start with the class digit', () => {
    for (const seed of SEEDS) {
      const seen = new Set<string>();
      for (const s of tt(seed).services) {
        assert.match(s.headcode, /^[0-9][A-Z][0-9]{2}$/);
        assert.equal(s.headcode[0], String(s.trainClass));
        assert.ok(!seen.has(s.headcode), `duplicate ${s.headcode} in seed ${seed}`);
        seen.add(s.headcode);
      }
    }
  });

  test('every timetable passes the independent validator (journeys, classes, platforms, timing, conflicts)', () => {
    for (const seed of SEEDS) assert.deepEqual(validateTimetable(ctx, tt(seed)), [], `seed ${seed}`);
  });

  test('the mixture is sensible: all three classes, both directions, the branch, never one direction only', () => {
    let withBranch = 0;
    for (const seed of SEEDS) {
      const sv = tt(seed).services;
      for (const c of [1, 2, 5]) assert.ok(sv.some((s) => s.trainClass === c), `seed ${seed} has class ${c}`);
      assert.ok(sv.filter((s) => s.trainClass === 1).length >= 2 && sv.filter((s) => s.trainClass === 1).length <= 3);
      assert.ok(sv.some((s) => s.entryLine === 'UP') && sv.some((s) => s.entryLine === 'DOWN'));
      if (sv.some((s) => s.entryLine === 'BRANCH' || s.exitLine === 'BRANCH')) withBranch++;
    }
    assert.equal(withBranch, SEEDS.length, 'every shift uses the branch (valid branch journeys exist)');
  });

  test('every journey exists in the logical network: consecutive sections really connect, from the boundary to the exit', () => {
    for (const seed of SEEDS.slice(0, 12)) {
      for (const s of tt(seed).services) {
        const first = net.boundaries.get(s.origin);
        assert.equal(first?.at.section, s.sections[0]);
        for (let i = 0; i + 1 < s.sections.length; i++) {
          const enter = i === 0 ? first!.at.end : undefined;
          // find the way the train actually entered section i by walking the plan
          void enter;
        }
        // walk: from the entry end through every section, each next section must be reachable by stepsFrom
        let end: 'A' | 'B' = first!.at.end;
        for (let i = 0; i < s.sections.length; i++) {
          const leaving = { section: s.sections[i] as string, end: otherEnd(end) };
          const next = stepsFrom(net, leaving);
          if (i === s.sections.length - 1) {
            assert.ok(next.some((n) => n.kind === 'exit' && n.boundary === s.destination), `${s.headcode} leaves at ${s.destination}`);
          } else {
            const hit = next.find((n) => n.kind === 'enter' && n.enter.section === s.sections[i + 1]);
            assert.ok(hit && hit.kind === 'enter', `${s.headcode}: ${s.sections[i]} connects to ${s.sections[i + 1]}`);
            end = hit.enter.end;
          }
        }
      }
    }
  });

  test('class rules: Class 1 mainline only, no platform, no branch, never stops; Class 2/5 platform stops are reachable', () => {
    for (const seed of SEEDS) {
      for (const s of tt(seed).services) {
        for (const sec of s.sections) assert.ok(classAllowsLine(s.trainClass, net.sections.get(sec)!.line, s.model), `${s.headcode} ${sec}`);
        if (s.trainClass === 1 && !isFlexibleClass1(s.model)) {
          assert.equal(s.stops, false);
          assert.equal(s.platform, null);
          assert.ok(!s.sections.some((x) => ['PLATFORM', 'BRANCH'].includes(net.sections.get(x)!.line)));
        }
        if (s.trainClass === 5) assert.ok(!s.sections.some((x) => net.sections.get(x)!.line === 'BRANCH'), 'Class 5 does not use the branch');
        if (s.stops) {
          assert.ok(net.platforms.get(s.platform!) && s.sections.includes(net.platforms.get(s.platform!)!.section));
          assert.ok(s.arrivalS !== null && s.departureS !== null && s.arrivalS! < s.departureS!);
        } else {
          assert.equal(s.arrivalS, null);
          assert.equal(s.departureS, null);
        }
        // Platform 1 is eastbound only: not reachable from Northbridge
        if (s.platform === 'PLAT1') assert.notEqual(s.origin, 'N-IN');
      }
    }
  });

  test('times are ordered: entry < arrival < departure < exit, and station times are separate from boundary times', () => {
    for (const seed of SEEDS) {
      for (const s of tt(seed).services) {
        assert.ok(s.entryS >= 0);
        if (s.stops) {
          assert.ok(s.entryS < s.arrivalS! && s.arrivalS! < s.departureS! && s.departureS! < s.exitS);
          assert.ok(s.departureS! - s.arrivalS! >= s.minDwellS);
        } else assert.ok(s.exitS > s.entryS);
      }
    }
  });

  test('the same seed always gives the same timetable; different seeds differ', () => {
    const a = generateTimetable(ctx, 7);
    const b = generateTimetable(ctx, 7);
    assert.deepEqual(a, b);
    assert.notDeepEqual(tt(1).services.map((s) => s.headcode), tt(2).services.map((s) => s.headcode));
  });

  test('a valid fallback timetable exists, is deterministic, and is used when generation fails', () => {
    const fb = fallbackTimetable(ctx);
    assert.deepEqual(validateTimetable(ctx, fb), []);
    assert.equal(fb.usedFallback, true);
    assert.deepEqual(fb, fallbackTimetable(ctx));
    const forced = generateTimetable(ctx, 99, { maxAttempts: 0 });
    assert.equal(forced.usedFallback, true);
    assert.equal(forced.services.length, fb.services.length);
    assert.ok(forced.services.length >= 5 && forced.services.length <= 7);
    assert.equal(tt(1).usedFallback, false);
  });
});

describe('the validator rejects impossible timetables', () => {
  const base = (): ServiceSchedule[] => [...tt(1).services];
  // Fixed services with named rolling stock, so these tests do not depend on what a seed happens to generate.
  const mk = (hc: string, cls: 1 | 2 | 5, model: string, formation: string, origin: string, destination: string, platform: string | null, entryS: number, dwell = 0): ServiceSchedule => {
    const stock = { model, formation };
    const plan = sensiblePlans(ctx, planServices(ctx, { trainClass: cls, origin, destination, platform, lengthM: stockPerformance(stock).lengthM, model }), platform)[0]!;
    return buildService(ctx, { trainClass: cls, stock, origin, destination, platform, plan }, hc, entryS, dwell)!;
  };
  const FIXTURES: Record<string, ServiceSchedule> = {
    '1J53': mk('1J53', 1, '800', '5-car', 'N-IN', 'W-OUT', null, 100),
    '2D64': mk('2D64', 2, '170', '2-car', 'W-IN', 'N-OUT', 'PLAT1', 150, 90),
    '2A69': mk('2A69', 2, '150', '2-car', 'M-IO', 'N-OUT', null, 200),
    '5A18': mk('5A18', 5, '150', '2-car', 'N-IN', 'W-OUT', 'PLAT2', 250, 60),
  };
  const svc = (hc: string): ServiceSchedule => (hc === '1M32' ? { ...(FIXTURES['1J53'] as ServiceSchedule), headcode: '1M32', id: '1M32' } : (FIXTURES[hc] as ServiceSchedule));
  const issues = (services: ServiceSchedule[]) => validateTimetable(ctx, { services }, { countRange: [1, 99] });

  test('two trains entering the same boundary together', () => {
    const a = svc('1J53');
    const b = { ...svc('1M32'), entryS: a.entryS + 20 };
    assert.ok(conflictsBetween(ctx, a, b).some((m) => /only 20 s apart/.test(m)));
  });

  test('two trains scheduled onto the same platform at the same time', () => {
    const a = svc('2D64');
    const b = buildService(ctx, { trainClass: 2, stock: defaultStock(2), origin: 'W-IN', destination: 'N-OUT', platform: 'PLAT1', plan: planServices(ctx, { trainClass: 2, origin: 'W-IN', destination: 'N-OUT', platform: 'PLAT1' })[0]! }, '2Z99', a.entryS + 60, 60)!;
    const c = conflictsBetween(ctx, a, b);
    assert.ok(c.some((m) => /platform would be double-booked/.test(m)), c.join('|'));
  });

  test('opposing trains needing the same section at the same time (platform 2, both directions)', () => {
    const j = (o: string, d: string) => planServices(ctx, { trainClass: 2, origin: o, destination: d, platform: 'PLAT2' })[0]!;
    const a = buildService(ctx, { trainClass: 2, stock: defaultStock(2), origin: 'N-IN', destination: 'W-OUT', platform: 'PLAT2', plan: j('N-IN', 'W-OUT') }, '2A01', 100, 60)!;
    const b = buildService(ctx, { trainClass: 2, stock: defaultStock(2), origin: 'W-IN', destination: 'N-OUT', platform: 'PLAT2', plan: j('W-IN', 'N-OUT') }, '2A02', 110, 60)!;
    assert.ok(conflictsBetween(ctx, a, b).length > 0);
  });

  test('a Class 1 train given a platform stop or the branch is invalid', () => {
    const e = svc('1J53');
    assert.ok(validateService(ctx, { ...e, stops: true, platform: 'PLAT1', arrivalS: e.entryS + 100, departureS: e.entryS + 200 }).some((m) => /Class 1/.test(m)));
    const branch = svc('2A69');
    assert.ok(validateService(ctx, { ...branch, trainClass: 1, headcode: '1A69' }).length > 0);
  });

  test('a stopping train at a platform its journey cannot reach is invalid (Platform 1 from Northbridge)', () => {
    const d = svc('5A18');
    const bad = { ...d, platform: 'PLAT1' };
    assert.ok(validateService(ctx, bad).length > 0);
    assert.equal(planServices(ctx, { trainClass: 2, origin: 'N-IN', destination: 'W-OUT', platform: 'PLAT1' }).length, 0);
  });

  test('departing before it can arrive, before the minimum dwell, or exiting before the journey can finish', () => {
    const s = svc('2D64');
    assert.ok(validateService(ctx, { ...s, arrivalS: s.entryS + 5, departureS: s.entryS + 400 }).some((m) => /before it can physically get there/.test(m)));
    assert.ok(validateService(ctx, { ...s, departureS: s.arrivalS! + 5 }).some((m) => /minimum dwell/.test(m)));
    assert.ok(validateService(ctx, { ...s, exitS: s.entryS + 20 }).some((m) => /exit before its journey/.test(m)));
    assert.ok(validateService(ctx, { ...s, departureS: s.arrivalS! - 10 }).length > 0);
  });

  test('duplicate headcodes, wrong class digit, bad count, missing direction', () => {
    const a = svc('1J53');
    assert.ok(issues([a, { ...a, entryS: a.entryS + 900 }]).some((m) => /used twice/.test(m)));
    assert.ok(validateService(ctx, { ...a, headcode: '2J53' }).some((m) => /first digit/.test(m)));
    assert.ok(validateTimetable(ctx, { services: base().slice(0, 3) }).some((m) => /needs 5–7/.test(m)));
    const upOnly = base().filter((s) => s.entryLine === 'UP');
    assert.ok(validateTimetable(ctx, { services: upOnly }, { countRange: [1, 99] }).some((m) => /DOWN/.test(m)));
  });

  test('a journey the network does not have is invalid', () => {
    const s = svc('1J53');
    assert.ok(validateService(ctx, { ...s, planId: 'nonsense', sections: ['UPW2'] }).some((m) => /no such journey/.test(m)));
    assert.ok(validateService(ctx, { ...s, origin: 'W-OUT' }).length > 0);
  });
});

describe('journey options and profiles', () => {
  test('every option the generator may choose has a measured, completable profile', () => {
    for (const c of [1, 2, 5] as const) assert.ok(journeyOptions(ctx, c, defaultStock(c)).length > 0, `class ${c}`);
    for (const j of journeyOptions(ctx, 2, defaultStock(2))) if (j.origin === 'M-IO' || j.destination === 'M-IO') return;
    assert.fail('no branch journey for class 2');
  });
});

describe('formats, status and summary', () => {
  test('clock and delay text', () => {
    assert.equal(clockText(28800, 0), '08:00');
    assert.equal(clockText(28800, 930), '08:15');
    assert.equal(clockText(28800, 930, true), '08:15:30');
    assert.equal(delayText(null), '—');
    assert.equal(delayText(80), '+1:20');
    assert.equal(delayText(-30), '−0:30');
    assert.equal(delayText(0), '0:00');
  });

  const S = (over: Partial<ServiceSchedule>): ServiceSchedule => ({ ...(tt(1).services[0] as ServiceSchedule), ...over });
  const A = (over: Partial<ServiceActual>): ServiceActual => ({ ...emptyActual(), ...over });

  test('summary: completed vs cancelled vs failed, averages skip what does not apply, delays are actual − scheduled', () => {
    const sv = [
      S({ id: 'a', headcode: '2A01', trainClass: 2, entryS: 100, arrivalS: 300, departureS: 400, exitS: 500, stops: true }),
      S({ id: 'b', headcode: '1A02', trainClass: 1, entryS: 200, arrivalS: null, departureS: null, exitS: 400, stops: false }),
      S({ id: 'c', headcode: '5A03', trainClass: 5, entryS: 300, arrivalS: null, departureS: null, exitS: 600, stops: false }),
      S({ id: 'd', headcode: '2A04', trainClass: 2, entryS: 400, exitS: 700 }),
      S({ id: 'e', headcode: '2A05', trainClass: 2, entryS: 500, exitS: 800 }),
    ];
    const act = new Map<string, ServiceActual>([
      ['a', A({ entryS: 130, arrivalS: 360, departureS: 460, exitS: 590 })], // +30 +60 +60 +90
      ['b', A({ entryS: 200, exitS: 410 })], // 0, +10
      ['c', A({ entryS: 330, exitS: 590 })], // +30, −10 (early)
      ['d', A({ cancelledS: 100 })],
      ['e', A({ failedReason: 'x' })],
    ]);
    const m = summarise(4, sv, act);
    assert.equal(m.shiftId, 4);
    assert.equal(m.scheduled, 5);
    assert.equal(m.completed, 3);
    assert.equal(m.cancelled, 1);
    assert.equal(m.failed, 1);
    assert.deepEqual([m.class1, m.class2, m.class5], [1, 3, 1]);
    assert.equal(m.stoppedAtStation, 1);
    assert.equal(m.avgEntryDelayS, (30 + 0 + 30) / 3);
    assert.equal(m.avgArrivalDelayS, 60, 'only the one stopping train');
    assert.equal(m.avgDepartureDelayS, 60);
    assert.equal(m.avgExitDelayS, (90 + 10 - 10) / 3);
    assert.equal(m.onTime, 2);
    assert.equal(m.delayed, 1);
    assert.deepEqual(m.mostDelayed, { headcode: '2A01', delayS: 90 });
    assert.equal(m.totalDelayS, 90 + 10, 'early running does not offset lateness');
    const none = summarise(1, [sv[3] as ServiceSchedule], new Map([['d', A({ cancelledS: 1 })]]));
    assert.equal(none.completed, 0);
    assert.equal(none.avgExitDelayS, null);
    assert.equal(none.mostDelayed, null);
  });

  test('status and current delay come from facts; a late train stays late', () => {
    const s = S({ entryS: 100, arrivalS: 300, departureS: 400, exitS: 500, stops: true, platform: 'PLAT1' });
    assert.equal(deriveStatus(s, A({}), null, 50), 'Expected');
    assert.equal(deriveStatus(s, A({}), null, 120), 'Ready to enter');
    assert.equal(deriveStatus(s, A({ cancelledS: 5 }), null, 50), 'Cancelled');
    assert.equal(deriveStatus(s, A({ exitS: 510, entryS: 100 }), null, 520), 'Completed');
    assert.equal(currentDelayS(s, A({}), 50), null);
    assert.equal(currentDelayS(s, A({}), 190), 90, 'overdue entry counts as delay');
    assert.equal(currentDelayS(s, A({ entryS: 130 }), 200), 30);
    assert.equal(currentDelayS(s, A({ entryS: 130, arrivalS: 360 }), 370), 60);
    assert.equal(currentDelayS(s, A({ entryS: 130, arrivalS: 360 }), 520), 120, 'next event overdue by more');
    assert.equal(currentDelayS(s, A({ entryS: 130, arrivalS: 360, departureS: 460, exitS: 590 }), 600), 90, 'final exit delay');
  });
});
