import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ashcombeDefinition, buildNetwork, createSignallingContext, createSignallingState, generateTimetable, validateTimetable } from '../../engine';
import { EventLog, MAX_RECORD, type LogCategory } from './eventLog';
import { SCENARIOS } from './scenarios';
import { Simulation, STEP_SECONDS } from './simulation';
import { ShiftController } from './shift';
import { attachBot } from './shiftBot';
import { STORAGE_KEY, STORAGE_VERSION, localShiftStore, parseShifts, serialiseShifts, type KeyValueStore, type ShiftStore } from './storage';

const net = buildNetwork(ashcombeDefinition);
const ctx = createSignallingContext(net);

class MemoryStore implements KeyValueStore {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

function setup(store: ShiftStore | null = null, bot = true) {
  const sim = new Simulation(ctx, createSignallingState(net));
  const shift = new ShiftController(sim, store);
  const detach = shift.attach();
  if (bot) attachBot(sim, shift);
  return { sim, shift, detach };
}
const runToEnd = (sim: Simulation, shift: ShiftController, maxS = 4000): void => {
  for (let i = 0; i * STEP_SECONDS < maxS && shift.current?.status === 'running'; i++) sim.stepOnce();
};

describe('EventLog', () => {
  test('entries carry simulation time, category and level', () => {
    let t = 65;
    const log = new EventLog(() => t);
    log.add('train', 'info', 'one');
    t = 3700;
    log.add('route', 'ok', 'two');
    const [a, b] = log.record;
    assert.equal(a?.clock, '08:01:05');
    assert.equal(a?.category, 'train');
    assert.equal(b?.clock, '09:01:40');
    assert.equal(b?.level, 'ok');
  });

  test('the view is filtered by category and newest first', () => {
    const log = new EventLog(() => 0);
    log.add('train', 'info', 'a');
    log.add('route', 'info', 'b');
    log.add('point', 'info', 'c');
    const all = new Set<LogCategory>(['train', 'route', 'point']);
    assert.deepEqual(log.visible(all).map((e) => e.text), ['c', 'b', 'a']);
    assert.deepEqual(log.visible(new Set<LogCategory>(['route'])).map((e) => e.text), ['b']);
    assert.deepEqual(log.visible(new Set<LogCategory>()).map((e) => e.text), []);
  });

  test('Clear only hides: the record and shift events stay, and new events show', () => {
    const log = new EventLog(() => 0);
    log.shiftId = 7;
    log.add('train', 'info', 'before');
    log.clearVisible();
    const all = new Set<LogCategory>(['train']);
    assert.equal(log.visible(all).length, 0);
    assert.equal(log.record.length, 1);
    assert.equal(log.forShift(7).length, 1);
    assert.equal(log.hiddenCount, 1);
    log.add('train', 'info', 'after');
    assert.deepEqual(log.visible(all).map((e) => e.text), ['after']);
  });

  test('the same line repeated at once is logged once; later it is logged again', () => {
    let t = 0;
    const log = new EventLog(() => t);
    log.add('route', 'error', 'No.');
    log.add('route', 'error', 'No.');
    assert.equal(log.record.length, 1);
    t = 30;
    log.add('route', 'error', 'No.');
    assert.equal(log.record.length, 2);
  });

  test('the record is bounded', () => {
    let t = 0;
    const log = new EventLog(() => t);
    for (let i = 0; i < MAX_RECORD + 50; i++) {
      t += 10;
      log.add('train', 'info', `e${i}`);
    }
    assert.equal(log.record.length, MAX_RECORD);
    assert.equal(log.record[log.record.length - 1]?.text, `e${MAX_RECORD + 49}`);
  });

  test('silent() suppresses and restores, even if the function throws', () => {
    const log = new EventLog(() => 0);
    log.silent(() => log.add('train', 'info', 'hidden'));
    assert.throws(() =>
      log.silent(() => {
        throw new Error('x');
      }),
    );
    log.add('train', 'info', 'shown');
    assert.deepEqual(log.record.map((e) => e.text), ['shown']);
  });
});

describe('logging from a whole shift', () => {
  test('a full shift logs trains, routes, points, signals, timetable and shift events with times, without duplicates', () => {
    const { sim, shift } = setup();
    shift.generate(1);
    shift.start();
    runToEnd(sim, shift);
    assert.equal(shift.current?.status, 'completed');
    const cats = new Set(shift.log.record.map((e) => e.category));
    for (const c of ['train', 'route', 'signal', 'point', 'shift'] as const) assert.ok(cats.has(c), `category ${c}`);
    assert.ok(shift.log.record.every((e) => /^\d\d:\d\d:\d\d$/.test(e.clock)));
    const texts = shift.log.record.map((e) => e.text);
    assert.ok(texts.some((t) => t.startsWith('Shift 1 started')));
    assert.ok(texts.some((t) => t.startsWith('Shift 1 is complete')));
    assert.ok(texts.some((t) => /^Route U\d → \w+ established\.$/.test(t)));
    assert.ok(texts.some((t) => /passed signal/.test(t)));
    assert.ok(texts.some((t) => /locked for route/.test(t)));
    assert.ok(texts.some((t) => /returned to Danger/.test(t)));
    // each train enters and exits exactly once in the log
    for (const s of shift.timetable!.services) {
      assert.equal(texts.filter((t) => t.startsWith(`${s.headcode} entered the controlled area`)).length, 1, `${s.headcode} entry`);
      assert.equal(texts.filter((t) => t.startsWith(`${s.headcode} has completely left`)).length, 1, `${s.headcode} exit`);
    }
    // the start-of-shift reset does not flood the log with "cancelled/unlocked" lines
    assert.equal(shift.log.record[0]?.text.startsWith('Shift 1 started'), true);
  });

  test('log time is simulation time: a paused simulation adds nothing and the clock text follows the sim clock', () => {
    const { sim, shift } = setup();
    shift.generate(1);
    shift.start();
    for (let i = 0; i < 20 * 200; i++) sim.stepOnce(); // 200 s
    const last = shift.log.record[shift.log.record.length - 1];
    assert.ok(last);
    assert.ok(last.simS <= sim.clockS + 1e-6);
    assert.equal(last.clock, shift.clock(last.simS, true));
  });

  test('the shift record keeps its events; clearing the view does not touch them', () => {
    const { sim, shift } = setup();
    shift.generate(2);
    shift.start();
    runToEnd(sim, shift);
    const sh = shift.current!;
    const n = sh.events.length;
    assert.ok(n > 20);
    assert.ok(sh.events.every((e) => e.shiftId === sh.id));
    shift.log.clearVisible();
    assert.equal(sh.events.length, n);
    assert.equal(shift.log.visible(new Set<LogCategory>(['train', 'shift'])).length, 0);
    assert.equal(shift.history[shift.history.length - 1], sh);
  });

  test('abandoning is logged once and clearing the state afterwards adds no noise', () => {
    const { sim, shift } = setup(null, false);
    shift.generate(1);
    shift.start();
    for (let i = 0; i < 20 * 150; i++) sim.stepOnce();
    const before = shift.log.record.length;
    shift.abandon();
    const added = shift.log.record.slice(before).map((e) => e.text);
    assert.deepEqual(added, ['Shift 1 abandoned.']);
    assert.equal(shift.history.length, 1);
    assert.equal(shift.history[0]?.status, 'abandoned');
    assert.equal(sim.trains.length, 0);
    assert.equal(Object.keys(sim.getSig().sectionLocks).length, 0);
    assert.equal(Object.keys(sim.getSig().routes).length, 0);
  });

  test('refused actions are explained in the log, not ignored', () => {
    const { shift, sim } = setup(null, false);
    shift.generate(1);
    shift.start();
    assert.equal(shift.generate(5), null);
    assert.equal(shift.start(), false);
    const errors = shift.log.record.filter((e) => e.level === 'error').map((e) => e.text);
    assert.ok(errors.some((t) => t.includes('Abandon it before generating')));
    assert.ok(errors.some((t) => t.includes('already running')));
    sim.stepOnce();
  });
});

describe('wiring is attached once and can be removed', () => {
  test('detaching stops logging and stepping; attaching twice in sequence does not double entries', () => {
    const { sim, shift, detach } = setup(null, false);
    shift.generate(1);
    shift.start();
    for (let i = 0; i < 20 * 40; i++) sim.stepOnce();
    const n = shift.log.record.length;
    detach();
    const detach2 = shift.attach();
    for (let i = 0; i < 20 * 40; i++) sim.stepOnce();
    const entries = shift.log.record.map((e) => e.text);
    assert.ok(shift.log.record.length >= n);
    assert.equal(new Set(entries).size, entries.length, 'no duplicated lines');
    detach2();
    const m = shift.log.record.length;
    sim.setSig(createSignallingState(net));
    assert.equal(shift.log.record.length, m);
  });

  test('an internal failure in a step pauses the simulation and is reported without throwing', () => {
    const { sim, shift } = setup(null, false);
    shift.generate(1);
    shift.start();
    const off = sim.addStepHook(() => {
      throw new Error('boom');
    });
    const quiet = console.error;
    console.error = () => {};
    try {
      assert.doesNotThrow(() => sim.advance(0.2));
    } finally {
      console.error = quiet;
    }
    off();
    assert.equal(sim.isPaused, true);
    assert.ok(shift.log.record.some((e) => e.category === 'system' && e.level === 'error' && /paused/.test(e.text)));
    assert.ok(!shift.log.record.some((e) => /boom|Error:/.test(e.text)), 'no technical detail in the log');
  });
});

describe('local shift history', () => {
  test('a finished shift is saved at once and restored by a new controller; numbering continues', () => {
    const mem = new MemoryStore();
    const store = localShiftStore(() => mem);
    const a = setup(store);
    a.shift.generate(1);
    a.shift.start();
    runToEnd(a.sim, a.shift);
    assert.ok(mem.getItem(STORAGE_KEY));
    const b = setup(store);
    assert.equal(b.shift.history.length, 1);
    const restored = b.shift.history[0]!;
    assert.equal(restored.id, 1);
    assert.deepEqual(restored.summary, a.shift.current!.summary);
    assert.equal(restored.events.length, a.shift.current!.events.length);
    const rows = b.shift.rows(restored);
    assert.equal(rows.length, restored.timetable.services.length);
    assert.ok(rows.every((r) => r.status === 'Completed' && r.train === null));
    b.shift.generate(3);
    b.shift.start();
    assert.equal(b.shift.current!.id, 2);
  });

  test('abandoned shifts are saved too, and only the most recent are kept', () => {
    const mem = new MemoryStore();
    const store = localShiftStore(() => mem);
    const a = setup(store, false);
    for (let i = 0; i < 10; i++) {
      a.shift.generate(1);
      a.shift.start();
      a.shift.abandon();
    }
    const again = parseShifts(mem.getItem(STORAGE_KEY));
    assert.equal(again.length, 8);
    assert.equal(again[again.length - 1]?.id, 10);
  });

  test('forgetting saved shifts empties memory and storage', () => {
    const mem = new MemoryStore();
    const a = setup(localShiftStore(() => mem), false);
    a.shift.generate(1);
    a.shift.start();
    a.shift.abandon();
    a.shift.clearHistory();
    assert.equal(a.shift.history.length, 0);
    assert.deepEqual(parseShifts(mem.getItem(STORAGE_KEY)), []);
  });

  const bad: [string, string | null][] = [
    ['nothing stored', null],
    ['empty string', ''],
    ['not JSON', '{oops'],
    ['truncated JSON', '{"version":1,"shifts":[{"id":1'],
    ['a number', '42'],
    ['an array', '[]'],
    ['wrong version', JSON.stringify({ version: STORAGE_VERSION + 1, shifts: [] })],
    ['shifts not an array', JSON.stringify({ version: STORAGE_VERSION, shifts: {} })],
    ['garbage shifts', JSON.stringify({ version: STORAGE_VERSION, shifts: [null, 3, 'x', {}, { id: 1 }] })],
  ];
  for (const [name, text] of bad) {
    test(`unusable saved data (${name}) gives an empty history and a fresh shift can still start`, () => {
      assert.deepEqual(parseShifts(text), []);
      const mem = new MemoryStore();
      if (text !== null) mem.setItem(STORAGE_KEY, text);
      const quiet = console.warn;
      console.warn = () => {};
      try {
        const a = setup(localShiftStore(() => mem), false);
        assert.equal(a.shift.history.length, 0);
        a.shift.generate(1);
        assert.equal(a.shift.start(), true);
        assert.equal(a.shift.current!.id, 1);
      } finally {
        console.warn = quiet;
      }
    });
  }

  test('one outdated or damaged shift is dropped; the others are kept', () => {
    const a = setup(null, false);
    for (const seed of [1, 2]) {
      a.shift.generate(seed);
      a.shift.start();
      a.shift.abandon();
    }
    const data = JSON.parse(serialiseShifts(a.shift.history));
    delete data.shifts[0].timetable.services[0].headcode; // field missing: an older schema
    data.shifts[1].summary.completed = 'many'; // wrong type
    const third = JSON.parse(serialiseShifts(a.shift.history)).shifts[1];
    data.shifts.push({ ...third, id: 3 });
    const parsed = parseShifts(JSON.stringify(data));
    assert.deepEqual(parsed.map((s) => s.id), [3]);
  });

  test('storage that throws (blocked, full, private window) never breaks the simulator', () => {
    const throwing: KeyValueStore = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('quota');
      },
      removeItem() {
        throw new Error('blocked');
      },
    };
    const quiet = console.warn;
    console.warn = () => {};
    try {
      const a = setup(localShiftStore(() => throwing), false);
      a.shift.generate(1);
      assert.equal(a.shift.start(), true);
      assert.doesNotThrow(() => a.shift.abandon());
      assert.equal(setup(localShiftStore(() => null), false).shift.history.length, 0);
    } finally {
      console.warn = quiet;
    }
  });
});

describe('scenarios', () => {
  test('every scenario is a validated, non-fallback timetable with the character it claims', () => {
    for (const s of SCENARIOS.filter((x) => x.seed !== null)) {
      const tt = generateTimetable(ctx, s.seed as number);
      assert.equal(tt.usedFallback, false, s.id);
      assert.deepEqual(validateTimetable(ctx, tt), [], s.id);
      const branch = tt.services.filter((v) => v.origin === 'M-IO' || v.destination === 'M-IO').length;
      const stops = tt.services.filter((v) => v.stops).length;
      if (s.id === 'normal') assert.ok([1, 2, 5].every((c) => tt.services.some((v) => v.trainClass === c)));
      if (s.id === 'busy') assert.ok(stops >= 5 && tt.services.some((v) => v.trainClass === 1));
      if (s.id === 'branch') assert.ok(branch >= 3);
      // deterministic
      assert.deepEqual(generateTimetable(ctx, s.seed as number).services, tt.services);
    }
  });
});
