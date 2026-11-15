import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildNetwork } from '../engine/topology/network';
import { northbridgeDefinition } from '../engine/topology/northbridge';
import { northbridgeLayout } from './northbridgeLayout';
import { validateLayout } from './validate';
describe('northbridge layout', () => {
  it('agrees with the network', () => {
    assert.deepEqual(validateLayout(buildNetwork(northbridgeDefinition), northbridgeLayout), []);
  });
});
