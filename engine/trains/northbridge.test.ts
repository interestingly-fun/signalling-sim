import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildNetwork } from '../topology/network';
import { northbridgeDefinition } from '../topology/northbridge';
import { createSignallingContext, createSignallingState, requestRoute, type SignallingState } from '../signalling';
import { Simulation } from '../../ui/sim/simulation';
import { platformAllows, routeCorridors, trainCorridor } from './corridors';

const net = buildNetwork(northbridgeDefinition);
const ctx = createSignallingContext(net);
const routes = [...ctx.routes.values()];

describe('northbridge corridors and platform access (interlocking level)', () => {
  it('no derived route uses more than one corridor', () => {
    for (const r of routes) assert.ok(routeCorridors(net, r).length <= 1, `${r.id} mixes corridors`);
  });
  it('platform access: T1/T2 AJ only, T5/T6 BR only, T3/T4 both, NBW1/2 AJ, NBW3/4 BR', () => {
    const ok = (p: string, c: string) => platformAllows(net, p, c);
    for (const p of ['T1', 'T2', 'NBW1', 'NBW2']) { assert.ok(ok(p, 'AJ'), p); assert.ok(!ok(p, 'BR'), p); }
    for (const p of ['T5', 'T6', 'NBW3', 'NBW4']) { assert.ok(ok(p, 'BR'), p); assert.ok(!ok(p, 'AJ'), p); }
    for (const p of ['T3', 'T4']) { assert.ok(ok(p, 'AJ') && ok(p, 'BR'), p); }
  });
  it('trains take their corridor from the boundary they enter at', () => {
    const c = (o: string) => trainCorridor(net, { spec: { origin: o } } as never);
    assert.equal(c('AJ-IN'), 'AJ');
    for (const o of ['BR-F-IN', 'BR-S-IN']) assert.equal(c(o), 'BR');
  });
});

function setRoutes(sim: Simulation, pairs: readonly (readonly [string, string])[]): void {
  let s: SignallingState = sim.getSig();
  for (const [a, b] of pairs) {
    const r = requestRoute(ctx, s, a, b);
    assert.ok(r.ok, `${a}->${b}: ${r.ok ? '' : r.rejection.message}`);
    s = r.state;
  }
  sim.setSig(s);
}
const id = (name: string): string => [...net.signals.values()].find((s) => s.name === name)?.id ?? name;

describe('northbridge terminating train (headless)', () => {
  it('AJ train: arrives, dwells, changes ends only when standing, new headcode, departs and exits', () => {
    const sim = new Simulation(ctx, createSignallingState(net));
    const r = sim.createTerminalScheduled({ headcode: '2J83', trainClass: 2, model: '387', formation: '4-car', origin: 'AJ-IN', platform: 'T1', terminalDwellS: 60, onward: { headcode: '2B23', trainClass: 2, destination: 'AJ-OUT' } });
    assert.ok(r.ok, r.ok ? '' : r.reason);
    setRoutes(sim, [[id('NB01'), id('NB02')], [id('NB02'), id('NB03')], [id('NB03'), 'BUF1']].map(([a, b]) => [a!, b!] as const));
    let reversedWhileMoving = false;
    let sawReversing = false;
    let seenNew = false;
    for (let i = 0; i < 60 * 60 * 20 && !(sim.trains[0]?.finished); i++) {
      sim.stepOnce();
      const t = sim.trains[0];
      if (!t) break;
      if (t.terminal?.stage === 'reversing') { sawReversing = true; if (t.speedMs > 0.05) reversedWhileMoving = true; }
      if (t.spec.headcode === '2B23') seenNew = true;
      if (t.terminal?.stage === 'ready' && !t.finished && sim.getSig().routes.size < 4) {
        try { setRoutes(sim, [[id('NB31'), id('NB04')], [id('NB04'), id('NB05')], [id('NB05'), id('NB103')]].map(([a, b]) => [a!, b!] as const)); } catch { /* already set */ }
      }
    }
    assert.ok(sawReversing, 'never reversed');
    assert.ok(!reversedWhileMoving, 'reversed while moving');
    assert.ok(seenNew, 'headcode never changed');
  });
});
