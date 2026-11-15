import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateNetworkDef, buildNetwork } from './network';
import { deriveRoutes } from './routeTable';
import { northbridgeDefinition } from './northbridge';

describe('northbridge topology', () => {
  it('is valid', () => {
    assert.deepEqual(validateNetworkDef(northbridgeDefinition), []);
  });
  it('derives routes', () => {
    const net = buildNetwork(northbridgeDefinition);
    const r = deriveRoutes(net);
    console.log(r.length);
    for (const x of r) console.log(x.id, x.sections.length, x.features.join('|'));
  });
});
