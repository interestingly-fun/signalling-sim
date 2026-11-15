import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ashcombeDefinition, AUTOMATIC_NAME, MANUAL_NAME, SHUNTING_NAME, buildNetwork, computeAspects, createSignallingContext, createSignallingState, requestRoute, validateSignalNaming, type NetworkDef } from '../index';

const sigs = ashcombeDefinition.signals;

describe('signal identification (AJ convention)', () => {
  test('every signal follows the convention for its type, and no name is used twice', () => {
    assert.deepEqual(validateSignalNaming(ashcombeDefinition), []);
    assert.equal(new Set(sigs.map((s) => s.name)).size, sigs.length);
    assert.equal(sigs.length, 32);
  });

  test('11 manual AJ01-AJ11, 17 automatic AJ100-AJ116 and 4 shunting signals (AJ1 and AJ4 on the mains, AJ5 and AJ6 leaving the sidings; AJ2/AJ3 entry signals do not exist)', () => {
    const manual = sigs.filter((s) => s.type === 'manual').map((s) => s.name).sort();
    const auto = sigs.filter((s) => s.type === 'automatic').map((s) => s.name).sort();
    assert.deepEqual(manual, Array.from({ length: 11 }, (_, i) => `AJ${String(i + 1).padStart(2, '0')}`));
    assert.deepEqual(auto, Array.from({ length: 17 }, (_, i) => `AJ${100 + i}`));
    const shunt = sigs.filter((s) => s.type === 'shunting').map((s) => s.name).sort();
    assert.deepEqual(shunt, ['AJ1', 'AJ4', 'AJ5', 'AJ6']);
    assert.ok(manual.every((n) => MANUAL_NAME.test(n)) && auto.every((n) => AUTOMATIC_NAME.test(n)) && shunt.every((n) => SHUNTING_NAME.test(n)));
    assert.ok(!sigs.some((s) => /AJX/.test(s.name)), 'no AJX names');
  });

  test('the convention is audited: a wrong digit count or a duplicate is reported', () => {
    const bad: NetworkDef = { ...ashcombeDefinition, signals: sigs.map((s) => (s.id === 'U2' ? { ...s, name: 'AJ100' } : s.id === 'U3' ? { ...s, name: 'AJ100' } : s)) };
    const issues = validateSignalNaming(bad);
    assert.ok(issues.some((i) => /U2 \(manual\)/.test(i)));
    assert.ok(issues.some((i) => /share the name/.test(i)));
    assert.throws(() => buildNetwork(bad), /display name|share/i, 'the network itself refuses duplicates');
  });

  test('internal ids are unchanged: the interlocking still refers to the same signals', () => {
    for (const id of ['UW2', 'U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'UE1', 'P1E', 'P2E', 'P2W', 'DE2', 'D1', 'D2', 'D3', 'D4', 'DR1', 'MW1', 'M1', 'M2', 'MX1']) assert.ok(sigs.some((s) => s.id === id), id);
    const ctx = createSignallingContext(buildNetwork(ashcombeDefinition));
    assert.ok(ctx.route('U3>P2E') && ctx.route('D2>P2W'));
    assert.equal(ctx.routeName('U3>P2E'), 'AJ02 → AJ06');
    assert.equal(ctx.signalName('U1'), 'AJ102');
  });

  test('the name never decides behaviour: swapping a manual and an automatic signal\'s names changes no aspect and no route result', () => {
    const swapped: NetworkDef = { ...ashcombeDefinition, signals: sigs.map((s) => (s.id === 'U2' ? { ...s, name: 'AJ116' } : s.id === 'MX2' ? { ...s, name: 'AJ01' } : s)) };
    const run = (def: NetworkDef) => {
      const ctx = createSignallingContext(buildNetwork(def));
      let sig = createSignallingState(ctx.net);
      const out: unknown[] = [computeAspects(ctx, sig)];
      for (const [a, b] of [['U2', 'U3'], ['U3', 'U4'], ['U4', 'P1E'], ['D2', 'P2W'], ['U3', 'P2E']] as const) {
        const r = requestRoute(ctx, sig, a, b);
        out.push(r.ok, r.ok ? '' : r.rejection.code);
        if (r.ok) sig = r.state;
        out.push(computeAspects(ctx, sig));
      }
      return out;
    };
    assert.deepEqual(run(swapped), run(ashcombeDefinition));
  });

  test('numbering follows the direction of travel: UP main eastbound west to east, DOWN main westbound east to west', () => {
    const order = (ids: string[]) => ids.map((id) => sigs.find((s) => s.id === id)?.name);
    assert.deepEqual(order(['U2', 'U3', 'U4', 'U5']), ['AJ01', 'AJ02', 'AJ03', 'AJ04']);
    assert.deepEqual(order(['UW2', 'UW1', 'U1', 'U6', 'UE1']), ['AJ100', 'AJ101', 'AJ102', 'AJ103', 'AJ104']);
    assert.deepEqual(order(['DE2', 'DE1', 'D1', 'D4', 'DW1', 'DW2']), ['AJ105', 'AJ106', 'AJ107', 'AJ108', 'AJ109', 'AJ110']);
    assert.deepEqual(order(['D2', 'D3', 'P2W']), ['AJ07', 'AJ08', 'AJ09']);
  });
});
