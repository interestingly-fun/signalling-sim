/** ECS siding cycles are shown as two timetable entries generated together: the incoming ECS movement and the outgoing service. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ashcombeDefinition, buildNetwork, createSignallingContext, createSignallingState, generateTimetable } from '../../engine';
import { Simulation, STEP_SECONDS } from './simulation';
import { ShiftController, outgoingId } from './shift';
import { attachBot } from './shiftBot';

const net = buildNetwork(ashcombeDefinition);
const ctx = createSignallingContext(net);

function setup(seed: number) {
  const sim = new Simulation(ctx, createSignallingState(net));
  const shift = new ShiftController(sim);
  shift.attach();
  shift.setMessageSink(() => {});
  attachBot(sim, shift, {});
  shift.generate(seed);
  return { sim, shift };
}
const stepTo = (sim: Simulation, until: () => boolean, maxS = 5000): void => {
  for (let i = 0; i * STEP_SECONDS < maxS && !until(); i++) sim.stepOnce();
};
const seedWith = (pred: (tt: ReturnType<typeof generateTimetable>) => boolean): number => {
  for (let s = 1; s < 200; s++) if (pred(generateTimetable(ctx, s))) return s;
  throw new Error('no seed');
};
const siding1 = seedWith((t) => t.services.some((s) => s.ecs?.siding === 'SIDING1') && t.services.some((s) => !s.ecs && s.stops));
const siding2 = seedWith((t) => t.services.some((s) => s.ecs?.siding === 'SIDING2'));
const noEcs = seedWith((t) => !t.services.some((s) => s.ecs));

function cycle(seed: number, siding: string) {
  const { sim, shift } = setup(seed);
  const svc = shift.draft!.services.find((s) => s.ecs?.siding === siding)!;
  return { sim, shift, svc };
}
const entry = (shift: ShiftController, hc: string) => shift.entries().find((e) => e.headcode === hc)!;

describe('both timetable entries are generated together', () => {
  for (const [label, seed, siding] of [['Siding 1', siding1, 'SIDING1'], ['Siding 2', siding2, 'SIDING2']] as const) {
    test(`${label}: both entries are visible before the shift starts, linked and in chronological order`, () => {
      const { shift, svc } = cycle(seed, siding);
      assert.equal(shift.current, null);
      const inc = entry(shift, svc.headcode);
      const out = entry(shift, svc.ecs!.onward.headcode);
      assert.equal(inc.leg, 'incoming');
      assert.equal(inc.becomes, svc.ecs!.onward.headcode);
      assert.equal(inc.trainClass, 5);
      assert.equal(out.leg, 'outgoing');
      assert.equal(out.forHeadcode, svc.headcode, 'the outgoing entry names the ECS headcode');
      assert.equal(out.trainClass, svc.ecs!.onward.trainClass);
      assert.equal(out.row.service.model, inc.row.service.model);
      assert.equal(out.row.service.formation, inc.row.service.formation);
      assert.equal(out.row.service, inc.row.service, 'one underlying service: no second train');
      assert.equal(out.sortS, svc.departureS);
      assert.equal(inc.status, 'Expected');
      assert.equal(out.status, 'Expected');
      const all = shift.entries();
      assert.ok(all.findIndex((e) => e.entryId === inc.entryId) < all.findIndex((e) => e.entryId === out.entryId));
      for (let i = 1; i < all.length; i++) assert.ok(all[i - 1]!.sortS <= all[i]!.sortS, 'chronological');
      assert.equal(all.length, shift.draft!.services.length + shift.draft!.services.filter((s) => s.ecs).length);
      assert.ok(shift.draft!.services.filter((s) => s.ecs).every((s) => entry(shift, s.ecs!.onward.headcode).forHeadcode === s.headcode), 'every ECS turnaround has both');
    });

    test(`${label}: incoming completes when fully stabled; outgoing stays pending through the dwell, then departs under the new identity`, () => {
      const { sim, shift, svc } = cycle(seed, siding);
      shift.start();
      const a = () => shift.current!.actuals.get(svc.id)!;
      stepTo(sim, () => a().arrivalS !== null);
      assert.ok(a().arrivalS !== null);
      // fully stabled: the incoming entry is Completed at once, the outgoing one is not
      let t = sim.trains.find((x) => x.id === a().trainId)!;
      assert.equal(t.ecs?.stage, 'stabled');
      assert.equal(entry(shift, svc.headcode).status, 'Completed');
      assert.equal(entry(shift, svc.ecs!.onward.headcode).status, 'Expected');
      assert.equal(a().exitS, null);
      assert.equal(a().departureS, null);
      assert.equal(t.spec.headcode, svc.headcode, 'still the ECS identity while stabled');
      const trainId = t.id;
      // dwell: outgoing remains pending, incoming stays Completed
      stepTo(sim, () => sim.trains.find((x) => x.id === trainId)?.ecs?.stage === 'ready' || a().departureS !== null || a().exitS !== null);
      assert.equal(entry(shift, svc.headcode).status, 'Completed');
      assert.ok(['Expected', 'Ready to depart'].includes(entry(shift, svc.ecs!.onward.headcode).status));
      // departing: the same train has adopted the new headcode and class
      stepTo(sim, () => a().departureS !== null);
      t = sim.trains.find((x) => x.id === trainId)!;
      assert.equal(t.id, trainId, 'same physical train');
      assert.equal(t.spec.headcode, svc.ecs!.onward.headcode);
      assert.equal(t.spec.trainClass, svc.ecs!.onward.trainClass);
      assert.equal(sim.trains.filter((x) => !x.finished && (x.spec.headcode === svc.headcode || x.spec.headcode === svc.ecs!.onward.headcode)).length, 1);
      assert.ok(!['Expected', 'Completed'].includes(entry(shift, svc.ecs!.onward.headcode).status));
      assert.equal(entry(shift, svc.headcode).status, 'Completed');
      assert.equal(entry(shift, svc.headcode).headcode, svc.headcode, 'original ECS headcode kept');
      assert.equal(entry(shift, svc.ecs!.onward.headcode).forHeadcode, svc.headcode);
      stepTo(sim, () => a().exitS !== null);
      assert.equal(entry(shift, svc.ecs!.onward.headcode).status, 'Completed');
      assert.equal(entry(shift, svc.headcode).status, 'Completed');
    });
  }

  test('a cancelled ECS movement never marks the outgoing service Completed', () => {
    const { sim, shift, svc } = cycle(siding1, 'SIDING1');
    shift.start();
    assert.ok(shift.cancelService(svc.id));
    assert.equal(entry(shift, svc.headcode).status, 'Cancelled');
    assert.equal(entry(shift, svc.ecs!.onward.headcode).status, 'Cancelled');
    void sim;
  });

  test('selecting the outgoing entry opens that entry; selection ids resolve to the one train', () => {
    const { shift, svc } = cycle(siding2, 'SIDING2');
    shift.start();
    shift.select(outgoingId(svc.id));
    assert.equal(shift.entries().find((e) => e.entryId === shift.selectedServiceId)?.leg, 'outgoing');
  });
});

describe('ordinary timetables are unchanged', () => {
  test('a shift with an ECS turnaround alongside ordinary services: ordinary entries are exactly the service rows', () => {
    const { sim, shift } = setup(siding1);
    shift.start();
    stepTo(sim, () => !shift.running);
    assert.equal(shift.current!.status, 'completed');
    const whole = shift.entries().filter((e) => e.leg === 'whole');
    assert.ok(whole.length > 0);
    const rows = shift.rows();
    for (const e of whole) {
      const r = rows.find((x) => x.service.id === e.entryId)!;
      assert.equal(e.status, r.status);
      assert.equal(e.delayS, r.delayS);
      assert.equal(e.headcode, r.service.headcode);
    }
    assert.ok(shift.entries().every((e) => e.status === 'Completed'));
    assert.equal(shift.current!.summary!.scheduled, shift.rows().length, 'the summary still counts each physical train once');
  });

  test('a shift with no ECS movements has one entry per service and no outgoing entries', () => {
    const { shift } = setup(noEcs);
    const e = shift.entries();
    assert.equal(e.length, shift.draft!.services.length);
    assert.ok(e.every((x) => x.leg === 'whole'));
  });
});
