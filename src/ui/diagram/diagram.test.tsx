import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  ashcombeDefinition,
  buildNetwork,
  computeAspects,
  createSignallingContext,
  createSignallingState,
  requestRoute,
  setTestOccupancy,
  type SignallingState,
} from '../../engine';
import { ashcombeLayout } from '../../layout';
import { SignallingDiagram } from './SignallingDiagram';

const net = buildNetwork(ashcombeDefinition);
const ctx = createSignallingContext(net);
const fresh = () => createSignallingState(net);

interface Options {
  entrance?: string | null;
  destinations?: string[];
  proposalId?: string | null;
  proposalBlocked?: boolean;
}

function render(state: SignallingState, o: Options = {}): string {
  return renderToStaticMarkup(
    <SignallingDiagram
      net={net}
      layout={ashcombeLayout}
      state={state}
      aspects={computeAspects(ctx, state)}
      selection={null}
      entrance={o.entrance ?? null}
      destinations={new Set(o.destinations ?? [])}
      proposal={o.proposalId ? (ctx.route(o.proposalId) ?? null) : null}
      proposalBlocked={o.proposalBlocked ?? false}
      showSectionLabels={true}
      onSelect={() => undefined}
      onSignalClick={() => undefined}
    />,
  );
}

const count = (html: string, re: RegExp): number => (html.match(re) ?? []).length;

/** The markup of one signal's <g>, by its label text. */
function signalMarkup(html: string, id: string): string {
  const groups = html.split('<g class="signal ').slice(1);
  const found = groups.find((g) => g.includes(`>${id}</text>`));
  assert.ok(found, `signal ${id} is drawn`);
  return found.split('</g>')[0] ?? '';
}

describe('the diagram draws what the network contains', () => {
  const html = render(fresh());

  test('every signal is rendered (28)', () => {
    assert.equal(count(html, /<g class="signal /g), 28);
    for (const id of net.signals.keys()) signalMarkup(html, id);
  });

  test('automatic and manual signals are distinguished (17 and 11)', () => {
    assert.equal(count(html, /<g class="signal automatic/g), 17);
    assert.equal(count(html, /<g class="signal manual/g), 11);
    for (const s of net.signals.values()) {
      const m = signalMarkup(html, s.id);
      assert.equal(m.includes('class="signal-ring"'), s.type === 'manual', `${s.id} ring`);
    }
  });

  test('all 50 sections, 11 points and both platforms are rendered', () => {
    assert.equal(count(html, /<g class="section"/g), 50);
    assert.equal(count(html, /<g class="point /g), 11);
    assert.equal(count(html, /class="platform/g), 2);
  });
});

describe('aspects are drawn from the computed aspects', () => {
  test('initial state: manual signals Red, U1 single Yellow, U6 Green', () => {
    const html = render(fresh());
    for (const s of net.signals.values()) if (s.type === 'manual') assert.match(signalMarkup(html, s.id), /class="lamp red"/, s.id);
    assert.match(signalMarkup(html, 'U1'), /class="lamp yellow"/);
    assert.match(signalMarkup(html, 'U6'), /class="lamp green"/);
  });

  test('all four aspects can be drawn, and Double Yellow shows two lamps', () => {
    let s = fresh();
    for (const [from, to] of [
      ['U2', 'U3'],
      ['U3', 'U4'],
    ] as const) {
      const r = requestRoute(ctx, s, from, to);
      assert.ok(r.ok);
      s = r.state;
    }
    // U4 red, U3 yellow, U2 double yellow, U1 green
    const html = render(s);
    assert.match(signalMarkup(html, 'U4'), /class="lamp red"/);
    assert.match(signalMarkup(html, 'U3'), /class="lamp yellow"/);
    const u2 = signalMarkup(html, 'U2');
    assert.equal(count(u2, /class="lamp yellow"/g), 2);
    assert.match(signalMarkup(html, 'U1'), /class="lamp green"/);
  });

  test('the drawn aspect changes when occupancy changes', () => {
    let s = fresh();
    const r = requestRoute(ctx, s, 'U2', 'U3');
    assert.ok(r.ok);
    s = r.state;
    assert.doesNotMatch(signalMarkup(render(s), 'U2'), /class="lamp red"/);
    assert.match(signalMarkup(render(setTestOccupancy(s, 'UP4', true)), 'U2'), /class="lamp red"/);
  });
});

describe('routes, locks and previews are drawn', () => {
  test('an established route shows reserved sections and locked points', () => {
    const r = requestRoute(ctx, fresh(), 'M1', 'U3');
    assert.ok(r.ok);
    const html = render(r.state);
    assert.equal(count(html, /class="track set/g), 5, 'BR2 LB1 LBX LB2 UP4');
    assert.equal(count(html, /class="point-lock"/g), 2, 'BJ and UJ');
    assert.equal(count(html, /class="point reverse locked/g), 2);
    assert.equal(count(render(fresh()), /class="point-lock"/g), 0);
  });

  test('a proposed route is previewed, and a blocked proposal is drawn differently', () => {
    const ok = render(fresh(), { proposalId: 'U3>DR1' });
    assert.equal(count(ok, /class="track route"/g), 4, 'UP5 XW DN7 DN6');
    const blocked = render(fresh(), { proposalId: 'U3>DR1', proposalBlocked: true });
    assert.equal(count(blocked, /class="track route blocked"/g), 4);
    assert.equal(count(ok, /route blocked/g), 0);
  });

  test('the entrance and its destinations are marked', () => {
    const html = render(fresh(), { entrance: 'U3', destinations: ['U4', 'DR1', 'P2E'] });
    assert.match(signalMarkup(html, 'U3'), /signal-target/);
    assert.equal(count(html, /class="signal manual entrance/g), 1);
    assert.equal(count(html, /destination/g) >= 3, true);
    assert.equal(count(render(fresh()), /signal-target/g), 0);
  });

  test('an occupied section is drawn occupied', () => {
    assert.equal(count(render(setTestOccupancy(fresh(), 'UP8', true)), /class="track occupied/g), 1);
  });
});
