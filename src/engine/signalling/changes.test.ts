import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ashcombeDefinition, buildNetwork, createSignallingContext, createSignallingState, diffSignalling, requestRoute, cancelRouteFrom, detachRoute, movePoint, setSignalOverride, type SignallingState } from '..';

const net = buildNetwork(ashcombeDefinition);
const ctx = createSignallingContext(net);
const fresh = (): SignallingState => createSignallingState(net);
const set = (s: SignallingState, from: string, to: string): SignallingState => {
  const r = requestRoute(ctx, s, from, to);
  assert.ok(r.ok, `route ${from}>${to}`);
  return r.state;
};
const texts = (a: SignallingState, b: SignallingState) => diffSignalling(ctx, a, b).map((c) => `${c.category}: ${c.text}`);

describe('diffSignalling: what changed, in operator language', () => {
  test('identical states report nothing', () => {
    const s = fresh();
    assert.deepEqual(diffSignalling(ctx, s, s), []);
  });

  test('establishing a route reports the route, the manual signal clearing, and any point locks and moves', () => {
    const a = set(set(fresh(), 'U2', 'U3'), 'U3', 'U4');
    const b = set(a, 'U4', 'P1E');
    const t = texts(a, b);
    assert.ok(t.includes('route: Route U4 → P1E established.'), t.join('|'));
    assert.ok(t.some((x) => x.startsWith('signal: Signal U4 cleared')), t.join('|'));
    assert.ok(t.some((x) => x.startsWith('point: Point') && x.includes('locked for route U4 → P1E')), t.join('|'));
    assert.ok(t.some((x) => /^point: Point \w+ moved to Reverse\./.test(x)), t.join('|'));
  });

  test('cancelling reports the cancellation, the signal returning to Danger, and the unlocking', () => {
    const a = set(fresh(), 'U2', 'U3');
    const r = cancelRouteFrom(ctx, a, 'U2');
    assert.ok(r.ok);
    const t = texts(a, r.state);
    assert.ok(t.includes('route: Route U2 → U3 cancelled.'), t.join('|'));
    assert.ok(t.includes('signal: Signal U2 returned to Danger.'), t.join('|'));
  });

  test('a route whose signal a train has passed is NOT reported as cancelled', () => {
    const a = set(fresh(), 'U2', 'U3');
    const routeId = a.routes['U2'] as string;
    const route = ctx.route(routeId);
    assert.ok(route);
    const b = detachRoute(a, route);
    assert.ok(b.residual[routeId]);
    const t = texts(a, b);
    assert.ok(!t.some((x) => x.includes('cancelled')), t.join('|'));
    assert.ok(t.includes('signal: Signal U2 returned to Danger.'), t.join('|'));
  });

  test('a point moved by hand is reported', () => {
    const r = movePoint(ctx, fresh(), 'PW1', 'reverse');
    assert.ok(r.ok);
    assert.deepEqual(texts(fresh(), r.state), ['point: Point PW1 moved to Reverse.']);
  });

  test('forcing an automatic signal to Danger and restoring it are reported', () => {
    const f = setSignalOverride(ctx, fresh(), 'D1', 'FORCED_DANGER');
    assert.ok(f.ok);
    assert.deepEqual(texts(fresh(), f.state), ['signal: Signal D1 forced to Danger.']);
    const g = setSignalOverride(ctx, f.state, 'D1', 'AUTOMATIC');
    assert.ok(g.ok);
    assert.deepEqual(texts(f.state, g.state), ['signal: Signal D1 restored from forced Danger.']);
  });

  test('U5 is manual: setting a route through it reports it clearing', () => {
    let s = fresh();
    s = set(s, 'U5', 'U6');
    const t = texts(fresh(), s);
    assert.ok(t.some((x) => x.startsWith('signal: Signal U5 cleared')), t.join('|'));
  });

  test('automatic signals changing aspect are not reported (only forcing is)', () => {
    const a = set(fresh(), 'U2', 'U3');
    const t = texts(fresh(), a);
    assert.ok(!t.some((x) => /Signal (UW|DW|UE|DE|D\d)/.test(x)), t.join('|'));
  });
});
