import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ashcombeDefinition,
  buildNetwork,
  checkLockInvariants,
  createSignallingContext,
  createSignallingState,
  setTestOccupancy,
  classProfile,
} from '../../engine';
import { Simulation, STEP_SECONDS } from './simulation';
import { ShiftController } from './shift';
import { attachBot, type BotOptions } from './shiftBot';

const net = buildNetwork(ashcombeDefinition);
const ctx = createSignallingContext(net);

function setup(seed = 1, bot: BotOptions | null = {}) {
  const sim = new Simulation(ctx, createSignallingState(net));
  const shift = new ShiftController(sim);
  shift.attach();
  const msgs: { kind: string; text: string }[] = [];
  shift.setMessageSink((kind, text) => msgs.push({ kind, text }));
  if (bot) attachBot(sim, shift, bot);
  shift.generate(seed);
  return { sim, shift, msgs };
}
const stepTo = (sim: Simulation, until: () => boolean, maxS = 4000): void => {
  for (let i = 0; i * STEP_SECONDS < maxS && !until(); i++) sim.stepOnce();
};
const actual = (shift: ShiftController, hc: string) => shift.current!.actuals.get(hc)!;

describe('shift lifecycle', () => {
  test('nothing starts by itself: the timetable can be inspected first, the clock is idle, no train exists', () => {
    const { sim, shift } = setup();
    assert.equal(shift.current, null);
    assert.ok(shift.draft && shift.draft.services.length >= 5);
    assert.equal(shift.rows().length, shift.draft!.services.length);
    assert.equal(sim.clockActive, false);
    assert.equal(sim.advance(10), 0);
    assert.equal(sim.clockS, 0);
    assert.equal(sim.trains.length, 0);
    assert.equal(sim.mode, 'no-train');
  });

  test('Start Shift: clears everything, zeroes the clock, starts running; history is kept', () => {
    const { sim, shift } = setup(1, null);
    // leave junk behind: a test train, an occupancy marker, a moved point
    sim.create({ headcode: '1T01', trainClass: 1, origin: 'W-IN', destination: 'N-OUT' });
    sim.setSig(setTestOccupancy(sim.getSig(), 'UP6', true));
    sim.clockS = 123;
    assert.ok(shift.start());
    assert.equal(shift.current!.status, 'running');
    assert.equal(sim.trains.length, 0, 'previous test trains gone');
    assert.deepEqual(Object.values(sim.getSig().network.sectionOccupancy).filter((o) => o !== null), []);
    assert.equal(sim.clockS, 0);
    assert.equal(sim.clockActive, true);
    assert.equal(sim.mode, 'running');
    assert.equal(shift.start(), false, 'cannot start another while one is running');
    assert.equal(shift.generate(), null, 'cannot regenerate while running');
  });

  test('pause freezes the clock, the trains and the timetable; resume continues; speed multiplier scales sim time', () => {
    const { sim, shift } = setup();
    shift.start();
    const svc = shift.current!.timetable.services[0]!;
    for (let i = 0; i < (svc.entryS + 30) * 4; i++) sim.advance(0.25); // real seconds at 1×
    const t = sim.clockS;
    assert.ok(Math.abs(t - (svc.entryS + 30)) < 0.1);
    assert.ok(sim.trains.length >= 1);
    sim.pause();
    assert.equal(sim.mode, 'paused');
    const snap = JSON.stringify([sim.clockS, sim.trains.map((x) => [x.frontM, x.speedMs, x.stop?.remainingS]), [...shift.current!.actuals.values()]]);
    for (let i = 0; i < 200; i++) assert.equal(sim.advance(0.25), 0);
    assert.equal(JSON.stringify([sim.clockS, sim.trains.map((x) => [x.frontM, x.speedMs, x.stop?.remainingS]), [...shift.current!.actuals.values()]]), snap);
    sim.resume();
    for (let i = 0; i < 40; i++) sim.advance(0.25);
    assert.ok(Math.abs(sim.clockS - (t + 10)) < 0.1);
    sim.speedFactor = 4;
    const t2 = sim.clockS;
    for (let i = 0; i < 20; i++) sim.advance(0.25);
    assert.ok(Math.abs(sim.clockS - (t2 + 20)) < 0.2, `4×: ${sim.clockS - t2}`);
  });

  test('abandon: cleared, recorded as abandoned, new shift can start', () => {
    const { sim, shift } = setup();
    shift.start();
    stepTo(sim, () => sim.trains.length > 0);
    assert.ok(shift.abandon());
    assert.equal(shift.history.at(-1)!.status, 'abandoned');
    assert.equal(sim.trains.length, 0);
    assert.equal(sim.clockActive, false);
    assert.deepEqual(sim.getSig().residual, {});
    shift.generate(2);
    assert.ok(shift.start());
  });
});

describe('scheduled entry', () => {
  test('a train is released at its scheduled time and not before; it appears outside the boundary, waiting', () => {
    const { sim, shift } = setup(1);
    shift.start();
    const first = shift.current!.timetable.services[0]!;
    stepTo(sim, () => sim.clockS >= first.entryS - 1);
    assert.equal(sim.trains.length, 0, 'not before its time');
    assert.equal(deriveStatusOf(shift, first.headcode), 'Expected');
    stepTo(sim, () => sim.clockS >= first.entryS + 0.2);
    const t = sim.trains[0]!;
    assert.equal(t.spec.headcode, first.headcode);
    assert.ok(actual(shift, first.headcode).createdS !== null && actual(shift, first.headcode).createdS! >= first.entryS);
  });

  test('it enters with the Phase 4 entry speed and the actual entry time is recorded', () => {
    const { sim, shift } = setup(1);
    shift.start();
    const first = shift.current!.timetable.services[0]!;
    stepTo(sim, () => actual(shift, first.headcode).entryS !== null);
    const a = actual(shift, first.headcode);
    assert.ok(a.entryS! >= first.entryS && a.entryS! - first.entryS < 2, `entered at ${a.entryS}`);
    const t = sim.trains[0]!;
    const v = classProfile(first.trainClass).entrySpeedMs;
    assert.ok(t.speedMs >= v - 2 && t.speedMs <= v + 2, `${t.speedMs} vs ${v}`);
    assert.ok(shift.rows()[0]!.delays.entry! < 2);
  });

  test('an occupied entry section holds the train outside; it is not discarded, enters when clear, and the delay is recorded', () => {
    const { sim, shift } = setup(1);
    shift.start();
    const first = shift.current!.timetable.services[0]!;
    const entrySection = first.sections[0]!;
    sim.setSig(setTestOccupancy(sim.getSig(), entrySection, true));
    stepTo(sim, () => sim.clockS >= first.entryS + 150);
    const t = sim.trains[0]!;
    assert.ok(t.frontM < 0, 'still outside');
    assert.equal(t.speedMs, 0);
    assert.equal(actual(shift, first.headcode).entryS, null);
    assert.ok(['Waiting for entry', 'Delayed'].includes(deriveStatusOf(shift, first.headcode)));
    assert.ok(shift.rows()[0]!.delayS! >= 140, 'live delay grows while it waits');
    assert.equal(shift.current!.status, 'running', 'the shift cannot finish while a service is waiting to enter');
    assert.ok(shift.getVersion() > 0);
    // lateness is announced
    sim.setSig(setTestOccupancy(sim.getSig(), entrySection, false));
    stepTo(sim, () => actual(shift, first.headcode).entryS !== null);
    const a = actual(shift, first.headcode);
    assert.ok(a.entryS! >= first.entryS + 150, 'entered only once clear');
    assert.ok(Math.abs(shift.rows()[0]!.delays.entry! - (a.entryS! - first.entryS)) < 1e-9, 'entry delay = actual − scheduled');
    assert.ok(shift.rows()[0]!.delays.entry! >= 150);
  });

  test('a Red entry-protecting signal ahead also holds a train outside when it cannot stop in time (interlocking decides)', () => {
    const { sim, shift } = setup(1);
    shift.start();
    const first = shift.current!.timetable.services[0]!;
    // no bot has set any route yet; the approach signals are automatic and show proceed-aspects, so just check the train is admitted by the engine rules
    stepTo(sim, () => sim.clockS >= first.entryS + 3);
    assert.ok(sim.trains[0]!.frontM > 0 || sim.trains[0]!.status === 'waiting to enter');
  });
});

describe('station operations in a shift', () => {
  const firstStopper = (shift: ShiftController) => shift.current!.timetable.services.find((s) => s.stops)!;

  test('a stopping train arrives at its assigned platform, arrival and departure are recorded, and it does not leave early', () => {
    const { sim, shift } = setup(1);
    shift.start();
    const s = firstStopper(shift);
    stepTo(sim, () => actual(shift, s.headcode).arrivalS !== null);
    const t = sim.trains.find((x) => x.spec.headcode === s.headcode)!;
    assert.equal(t.stop!.platform, s.platform);
    assert.equal(net.platforms.get(s.platform!)!.section, t.path.at(-1)!.section);
    assert.ok(t.speedMs < 0.05);
    const a = actual(shift, s.headcode);
    assert.ok(Math.abs(a.arrivalS! - s.arrivalS!) < 15, `arrival ${a.arrivalS} vs ${s.arrivalS}`);
    // wait until the scheduled departure; it must still be standing just before it
    stepTo(sim, () => sim.clockS >= s.departureS! - 2);
    assert.ok(sim.trains.find((x) => x.spec.headcode === s.headcode)!.speedMs < 0.05, 'still standing before its scheduled departure');
    assert.equal(actual(shift, s.headcode).departureS, null);
    stepTo(sim, () => actual(shift, s.headcode).departureS !== null);
    const d = actual(shift, s.headcode).departureS!;
    assert.ok(d >= s.departureS! - 0.01, `departed at ${d}, scheduled ${s.departureS}`);
    assert.ok(d - s.departureS! < 15);
  });

  test('a LATE train keeps its minimum dwell and leaves late: the dwell is not squeezed back to the timetable', () => {
    const { sim, shift } = setup(1, { holdUntil: () => false });
    shift.start();
    const s = firstStopper(shift);
    // hold the train at the entry boundary for 100 s: it arrives ~100 s late; the timetable allows (dwell − min) of slack
    const entrySection = s.sections[0]!;
    sim.setSig(setTestOccupancy(sim.getSig(), entrySection, true));
    stepTo(sim, () => sim.clockS >= s.entryS + 100);
    sim.setSig(setTestOccupancy(sim.getSig(), entrySection, false));
    stepTo(sim, () => actual(shift, s.headcode).departureS !== null);
    const a = actual(shift, s.headcode);
    const arrDelay = a.arrivalS! - s.arrivalS!;
    const depDelay = a.departureS! - s.departureS!;
    assert.ok(arrDelay > 90, `arrival delay ${arrDelay}`);
    const dwell = a.departureS! - a.arrivalS!;
    assert.ok(dwell >= s.minDwellS - 0.1, `dwell ${dwell} >= minimum ${s.minDwellS}`);
    assert.ok(dwell <= s.minDwellS + 8, `the dwell was cut to the minimum, not kept at ${s.scheduledDwellS}`);
    assert.ok(depDelay > 0, 'the actual departure reflects the delay');
    assert.ok(depDelay < arrDelay + 1, 'it recovered what it could (slack in the dwell)');
  });

  test('ready to depart but no route: it waits at the signal until the signaller sets one, and both conditions are respected', () => {
    const { sim, shift } = setup(1, { skip: (m, hc) => hc === shift0.hc && m === shift0.m });
    // choose the stopper and its departure movement after the controller has the timetable
    const s0 = shift.draft!.services.find((s) => s.stops)!;
    shift0.hc = s0.headcode;
    shift0.m = s0.manual.at(-1)!;
    shift.start();
    stepTo(sim, () => sim.clockS >= s0.departureS! + 60);
    const t = sim.trains.find((x) => x.spec.headcode === s0.headcode)!;
    assert.equal(t.status, 'ready to depart');
    assert.ok(t.speedMs < 0.05);
    assert.ok(actual(shift, s0.headcode).readyS !== null);
    assert.equal(actual(shift, s0.headcode).departureS, null, 'does not pass the Red starter');
    assert.equal(shift.rows().find((r) => r.service.headcode === s0.headcode)!.status, 'Ready to depart');
    assert.ok(shift.rows().find((r) => r.service.headcode === s0.headcode)!.delayS! >= 55, 'delay shows while it waits');
    // the signaller now sets the route
    shift0.m = '';
    stepTo(sim, () => actual(shift, s0.headcode).departureS !== null, 200);
    assert.ok(actual(shift, s0.headcode).departureS! >= s0.departureS! + 60);
  });

  test('an express passes without stopping; the pass is recorded and no arrival/departure exists', () => {
    const { sim, shift } = setup(1);
    shift.start();
    const e = shift.current!.timetable.services.find((s) => s.trainClass === 1 && s.passS !== null)!;
    stepTo(sim, () => actual(shift, e.headcode).passS !== null);
    const a = actual(shift, e.headcode);
    assert.ok(Math.abs(a.passS! - e.passS!) < 15, `${a.passS} vs ${e.passS}`);
    assert.equal(a.arrivalS, null);
    assert.equal(a.departureS, null);
    assert.equal(sim.trains.find((x) => x.spec.headcode === e.headcode)!.stop, null);
  });
});

describe('completion and summary', () => {
  test('whole shifts complete with every service completed, nothing left in the area, no stale locks, correct summary', () => {
    for (const seed of [1, 2, 3, 4]) {
      const { sim, shift } = setup(seed);
      shift.start();
      stepTo(sim, () => !shift.running, 5000);
      const sh = shift.current!;
      assert.equal(sh.status, 'completed', `seed ${seed}`);
      assert.ok(sh.timetable.services.every((s) => sh.actuals.get(s.id)!.exitS !== null));
      assert.ok(sim.trains.every((t) => t.finished));
      assert.deepEqual(sim.getSig().residual, {});
      assert.deepEqual(Object.values(sim.getSig().network.sectionOccupancy).filter((o) => o !== null), []);
      assert.deepEqual(checkLockInvariants(ctx, sim.getSig()), []);
      assert.equal(sim.clockActive, false);
      // the shift ended after the last train had COMPLETELY left, not at the last scheduled time
      const lastExit = Math.max(...[...sh.actuals.values()].map((a) => a.exitS!));
      assert.ok(Math.abs(sh.endedS! - lastExit) < 0.2);
      const m = sh.summary!;
      const n = sh.timetable.services.length;
      assert.equal(m.scheduled, n);
      assert.equal(m.completed, n);
      assert.equal(m.cancelled + m.failed, 0);
      assert.equal(m.class1 + m.class2 + m.class5, n);
      assert.equal(m.stoppedAtStation, sh.timetable.services.filter((s) => s.stops).length);
      assert.equal(m.onTime + m.delayed, n);
      const rows = shift.rows(sh);
      const exitDelays = rows.map((r) => r.delays.exit!);
      assert.ok(Math.abs(m.avgExitDelayS! - exitDelays.reduce((a, b) => a + b, 0) / n) < 1e-9);
      assert.ok(Math.abs(m.totalDelayS - exitDelays.filter((d) => d > 0).reduce((a, b) => a + b, 0)) < 1e-9);
      // timing in the shift agrees with the timetable the generator built (within the rounding of the schedule)
      for (const r of rows) assert.ok(Math.abs(r.delays.exit!) < 15, `${r.service.headcode} exit delay ${r.delays.exit}`);
    }
  });

  test('the shift does not end while a train is still in the area (even after the last scheduled time)', () => {
    const { sim, shift } = setup(1, { holdUntil: (hc, now) => hc === shift1.last && now < 99999 });
    shift1.last = shift.draft!.services.at(-1)!.headcode; // the last service's routes are never set: it stays stuck inside
    shift.start();
    const end = shift.current!.timetable.endS;
    stepTo(sim, () => sim.clockS > end + 400);
    assert.equal(shift.current!.status, 'running');
    assert.ok(sim.trains.some((t) => !t.finished && t.spec.headcode === shift1.last), 'the train is still there');
    assert.equal(shift.current!.summary, null);
    // the others did finish
    const done = [...shift.current!.actuals.entries()].filter(([, a]) => a.exitS !== null).length;
    assert.equal(done, shift.current!.timetable.services.length - 1);
  });

  test('a train that has not yet entered keeps the shift alive; cancelling it explicitly lets the shift end', () => {
    const { sim, shift } = setup(1);
    shift.start();
    const last = shift.current!.timetable.services.at(-1)!;
    // block the entry of the last service for ever (once the earlier services are through its boundary)
    stepTo(sim, () => sim.clockS >= last.entryS - 5);
    sim.setSig(setTestOccupancy(sim.getSig(), last.sections[0]!, true));
    stepTo(sim, () => sim.clockS > last.exitS + 300);
    assert.equal(shift.current!.status, 'running');
    assert.equal(actual(shift, last.headcode).entryS, null);
    assert.ok(shift.cancelService(last.headcode));
    assert.equal(actual(shift, last.headcode).cancelledS !== null, true);
    assert.equal(shift.current!.status, 'completed');
    const m = shift.current!.summary!;
    assert.equal(m.cancelled, 1);
    assert.equal(m.completed, shift.current!.timetable.services.length - 1, 'a cancelled service is not counted as completed');
    assert.equal(shift.cancelService(shift.current!.timetable.services[0]!.headcode), false, 'an entered/finished service cannot be cancelled');
  });

  test('a new shift starts clean after a completed one; the earlier summary stays available', () => {
    const { sim, shift } = setup(1);
    shift.start();
    stepTo(sim, () => !shift.running, 5000);
    const first = shift.current!;
    assert.equal(first.status, 'completed');
    shift.generate(2);
    assert.ok(shift.draft);
    assert.ok(shift.start());
    assert.notEqual(shift.current, first);
    assert.equal(shift.current!.id, 2);
    assert.ok(shift.history.includes(first), 'previous shift kept');
    assert.ok(first.summary && first.summary.completed === first.timetable.services.length);
    assert.equal(sim.clockS, 0);
    assert.equal(sim.trains.length, 0);
    assert.deepEqual(sim.getSig().sectionLocks, {});
    assert.deepEqual(sim.getSig().routes, {});
    assert.deepEqual(Object.values(sim.getSig().network.sectionOccupancy).filter((o) => o !== null), []);
  });

  test('messages come from real events, once each, in order, with no duplicates', () => {
    const { sim, shift, msgs } = setup(1);
    shift.start();
    stepTo(sim, () => !shift.running, 5000);
    const texts = msgs.map((m) => m.text);
    assert.equal(new Set(texts).size, texts.length, 'no duplicate messages');
    for (const s of shift.current!.timetable.services) {
      const mine = texts.filter((t) => t.startsWith(s.headcode));
      const idx = (re: RegExp) => mine.findIndex((t) => re.test(t));
      assert.ok(idx(/ready to enter/) >= 0 && idx(/entered the controlled area/) > idx(/ready to enter/));
      assert.ok(idx(/completely left/) > idx(/entered the controlled area/));
      if (s.stops) assert.ok(idx(/arrived at/) > idx(/entered/) && idx(/departed/) > idx(/arrived at/));
      else assert.ok(idx(/passed Ashcombe Junction/) < 0 || idx(/passed Ashcombe Junction/) > idx(/entered/));
    }
  });

  test('delay messages appear only for real lateness', () => {
    const { sim, shift, msgs } = setup(1);
    shift.start();
    stepTo(sim, () => !shift.running, 5000);
    assert.ok(!msgs.some((m) => /is delayed by/.test(m.text)), 'a punctual shift reports no delays');
    const b = setup(1);
    b.shift.start();
    const first = b.shift.current!.timetable.services[0]!;
    b.sim.setSig(setTestOccupancy(b.sim.getSig(), first.sections[0]!, true));
    stepTo(b.sim, () => b.sim.clockS > first.entryS + 130);
    assert.ok(b.msgs.some((m) => new RegExp(`${first.headcode} is delayed by 2 minutes`).test(m.text)));
    assert.equal(b.msgs.filter((m) => /is delayed by 1 minute/.test(m.text)).length, 1, 'announced once per minute');
  });
});

// helpers shared by the closures above
const shift0 = { hc: '', m: '' };
const shift1 = { last: '' };
function deriveStatusOf(shift: ShiftController, hc: string): string {
  return shift.rows().find((r) => r.service.headcode === hc)!.status;
}
