import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildNetwork } from '../topology/network';
import { northbridgeDefinition } from '../topology/northbridge';
import { createSignallingContext } from '../signalling';
import { planTerminalCycles } from '../trains';
import { terminalProfile } from './profile';

const ctx = createSignallingContext(buildNetwork(northbridgeDefinition));

describe('northbridge terminating cycles', () => {
  for (const [origin, dest, plat] of [['AJ-IN', 'AJ-OUT', 'T1'], ['AJ-IN', 'AJ-OUT', 'T2'], ['AJ-IN', 'AJ-OUT', 'T3'], ['AJ-IN', 'AJ-OUT', 'T4'], ['BR-F-IN', 'BR-F-OUT', 'T3'], ['BR-S-IN', 'BR-S-OUT', 'T4'], ['BR-F-IN', 'BR-S-OUT', 'T5'], ['BR-S-IN', 'BR-F-OUT', 'T6']] as const) {
    it(`${origin} -> ${plat} -> ${dest}`, () => {
      const plans = planTerminalCycles(ctx, { origin, platform: plat, destination: dest, lengthM: 160, stopMarginM: 12, trainClass: 2, onwardClass: 2, model: '170' });
      assert.ok(plans.length > 0, 'no plan');
      const p = terminalProfile(ctx, { stock: { model: '170', formation: '3-car' }, trainClass: 2, origin, platform: plat, terminalDwellS: 60, onward: { headcode: '2P01', trainClass: 2, destination: dest }, inboundCall: null, outboundCall: null, plan: plans[0]! });
      console.log(origin, plat, dest, plans.length, p && { a: Math.round(p.entryToArrivalS), r: Math.round(p.entryToReadyS), d: Math.round(p.entryToDepartureS), x: Math.round(p.entryToExitS) });
      assert.ok(p, 'profile null');
    });
  }
  it('forbidden combinations have no plan', () => {
    for (const [o, d, p] of [['AJ-IN', 'AJ-OUT', 'T5'], ['AJ-IN', 'AJ-OUT', 'T6'], ['BR-F-IN', 'BR-F-OUT', 'T1'], ['BR-F-IN', 'BR-F-OUT', 'T2'], ['AJ-IN', 'BR-F-OUT', 'T3'], ['BR-F-IN', 'AJ-OUT', 'T4']] as const) {
      assert.equal(planTerminalCycles(ctx, { origin: o, platform: p, destination: d, lengthM: 160, stopMarginM: 12, trainClass: 2, onwardClass: 2, model: '170' }).length, 0, `${o} ${p} ${d}`);
    }
  });
});
