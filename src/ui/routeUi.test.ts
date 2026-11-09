import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ashcombeDefinition, buildNetwork, createSignallingContext, createSignallingState, setTestOccupancy } from '../engine';
import { cancelBlock, clickSignal, destinationsFor, emptyRouteUi, establishMovement, previewMovement, submitCancel, submitRoute } from './routeUi';

const ctx = createSignallingContext(buildNetwork(ashcombeDefinition));
const fresh = () => createSignallingState(ctx.net);

describe('entrance-to-exit selection', () => {
  test('clicking a manual signal selects it as the entrance', () => {
    const u = clickSignal(ctx, fresh(), emptyRouteUi, 'U3');
    assert.deepEqual(u.ui, { entrance: 'U3', routeId: null });
    assert.equal(u.message?.kind, 'info');
  });

  test('clicking an automatic signal does not start a route', () => {
    const u = clickSignal(ctx, fresh(), emptyRouteUi, 'U1');
    assert.deepEqual(u.ui, emptyRouteUi);
    assert.match(u.message?.text ?? '', /automatic/);
  });

  test('clicking a reachable exit signal establishes the route immediately, with its points', () => {
    const u = clickSignal(ctx, fresh(), { entrance: 'U3', routeId: null }, 'DR1');
    assert.equal(u.message?.kind, 'ok');
    assert.ok(u.state, 'the signalling state changed');
    assert.equal(u.state?.routes['U3'], 'U3>DR1');
    assert.equal(u.state?.network.pointPositions['WXU'], 'reverse');
    assert.equal(u.state?.pointLocks['WXU'], 'U3>DR1');
    assert.deepEqual(u.ui, emptyRouteUi, 'selection is cleared after success');
    assert.match(u.message?.text ?? '', /WXU R/);
  });

  test('clicking an unreachable automatic signal says so, keeps the entrance and changes nothing', () => {
    const start = { entrance: 'U3', routeId: null };
    const u = clickSignal(ctx, fresh(), start, 'D1');
    assert.deepEqual(u.ui, start);
    assert.equal(u.state, undefined);
    assert.equal(u.message?.kind, 'error');
    assert.equal(u.message?.text, 'Invalid movement: no valid connection between U3 and D1.');
  });

  test('clicking another manual signal that is not an exit starts a different selection', () => {
    const u = clickSignal(ctx, fresh(), { entrance: 'U3', routeId: null }, 'D3');
    assert.deepEqual(u.ui, { entrance: 'D3', routeId: null });
    assert.equal(u.state, undefined);
  });

  test('clicking the entrance again clears the selection', () => {
    const u = clickSignal(ctx, fresh(), { entrance: 'U3', routeId: null }, 'U3');
    assert.deepEqual(u.ui, emptyRouteUi);
    assert.equal(u.state, undefined);
  });

  test('a refused route reports the interlocking reason, keeps the entrance, shows the movement as blocked, and changes nothing', () => {
    const s = setTestOccupancy(fresh(), 'UP8', true);
    const u = clickSignal(ctx, s, { entrance: 'U4', routeId: null }, 'U5');
    assert.equal(u.message?.kind, 'error');
    assert.match(u.message?.text ?? '', /section UP8 is occupied/);
    assert.equal(u.state, undefined);
    assert.deepEqual(u.ui, { entrance: 'U4', routeId: 'U4>U5' });
  });

  test('after a refusal another exit can be clicked and is not confused with the refused one', () => {
    const s = setTestOccupancy(fresh(), 'UP6', true); // blocks U3>U4 only
    const refused = clickSignal(ctx, s, { entrance: 'U3', routeId: null }, 'U4');
    assert.equal(refused.state, undefined);
    const ok = clickSignal(ctx, s, refused.ui, 'DR1');
    assert.equal(ok.state?.routes['U3'], 'U3>DR1');
  });

  test('conflicting routes are refused through the same click', () => {
    const first = clickSignal(ctx, fresh(), { entrance: 'U2', routeId: null }, 'U3');
    assert.ok(first.state);
    // M1>U3 reaches UP3/UP4 area that U2>U3 holds
    const conflict = clickSignal(ctx, first.state ?? fresh(), { entrance: 'M1', routeId: null }, 'U3');
    assert.equal(conflict.message?.kind, 'error');
    assert.equal(conflict.state, undefined);
  });

  test('an entrance that already has a route refuses a second one', () => {
    const first = clickSignal(ctx, fresh(), { entrance: 'U3', routeId: null }, 'U4');
    const again = clickSignal(ctx, first.state ?? fresh(), { entrance: 'U3', routeId: null }, 'DR1');
    assert.equal(again.state, undefined);
    assert.equal(again.message?.kind, 'error');
  });

  test('a signal that already has a route is selected showing that route', () => {
    const set = submitRoute(ctx, fresh(), { entrance: 'U2', routeId: 'U2>U3' });
    const u = clickSignal(ctx, set.state, emptyRouteUi, 'U2');
    assert.deepEqual(u.ui, { entrance: 'U2', routeId: 'U2>U3' });
    assert.match(u.message?.text ?? '', /Cancel route/);
  });

  test('destinations come from the network', () => {
    assert.deepEqual([...destinationsFor(ctx, 'U3')].sort(), ['DR1', 'P2E', 'U4']);
    assert.deepEqual(destinationsFor(ctx, null), []);
  });

  test('establishMovement (the Routes panel choice) is the same as clicking the exit', () => {
    const u = establishMovement(ctx, fresh(), { entrance: 'M1', routeId: null }, 'M1>U3');
    assert.equal(u.state?.routes['M1'], 'M1>U3');
  });

  test('previewing a movement chooses its entrance and exit', () => {
    const u = previewMovement(ctx, fresh(), 'M1>U3');
    assert.deepEqual(u.ui, { entrance: 'M1', routeId: 'M1>U3' });
  });
});

describe('setting and cancelling from the interface', () => {
  test('Set route establishes the proposed movement and clears the selection', () => {
    const r = submitRoute(ctx, fresh(), { entrance: 'M1', routeId: 'M1>U3' });
    assert.equal(r.message.kind, 'ok');
    assert.equal(r.state.routes['M1'], 'M1>U3');
    assert.deepEqual(r.ui, emptyRouteUi);
    assert.match(r.message.text, /BJ R/);
  });

  test('Set route without a proposal is refused', () => {
    const before = fresh();
    const r = submitRoute(ctx, before, { entrance: 'U3', routeId: null });
    assert.equal(r.message.kind, 'error');
    assert.equal(r.state, before);
  });

  test('a refused Set route keeps the proposal and the state', () => {
    const before = setTestOccupancy(fresh(), 'LB2', true);
    const ui = { entrance: 'M1', routeId: 'M1>U3' };
    const r = submitRoute(ctx, before, ui);
    assert.equal(r.message.kind, 'error');
    assert.match(r.message.text, /section LB2 is occupied/);
    assert.equal(r.state, before);
    assert.deepEqual(r.ui, ui);
  });

  test('Cancel route releases the route and clears a selection that pointed at it', () => {
    const set = submitRoute(ctx, fresh(), { entrance: 'U2', routeId: 'U2>U3' });
    const r = submitCancel(ctx, set.state, { entrance: 'U2', routeId: 'U2>U3' }, 'U2>U3');
    assert.equal(r.message.kind, 'ok');
    assert.deepEqual(r.state.routes, {});
    assert.deepEqual(r.ui, emptyRouteUi);
  });

  test('Cancel route on an occupied route is refused with the reason', () => {
    const set = submitRoute(ctx, fresh(), { entrance: 'U2', routeId: 'U2>U3' });
    const occupied = setTestOccupancy(set.state, 'UP3', true);
    assert.match(cancelBlock(ctx, occupied, 'U2>U3') ?? '', /cannot be cancelled: section UP3 is occupied/);
    const r = submitCancel(ctx, occupied, emptyRouteUi, 'U2>U3');
    assert.equal(r.message.kind, 'error');
    assert.equal(r.state, occupied);
    assert.equal(cancelBlock(ctx, set.state, 'U2>U3'), null);
  });
});
