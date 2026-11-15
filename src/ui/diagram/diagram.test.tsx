import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  const shown = net.signals.get(id)?.name ?? id; // the label is the display name (AJ01), the id is internal
  const found = groups.find((g) => g.includes(`>${shown}</text>`));
  assert.ok(found, `signal ${id} is drawn`);
  return found.split('</g>')[0] ?? '';
}

describe('the diagram draws what the network contains', () => {
  const html = render(fresh());

  test('every signal is rendered (32)', () => {
    assert.equal(count(html, /<g class="signal /g), 32);
    for (const id of net.signals.keys()) signalMarkup(html, id);
  });

  test('automatic and manual signals are distinguished (17 automatic, 11 manual, 4 shunting triangles)', () => {
    assert.equal(count(html, /<g class="signal automatic/g), 17);
    assert.equal(count(html, /<g class="signal manual/g), 11);
    assert.equal(count(html, /<g class="signal shunting/g), 4);
    assert.equal(count(html, /class="shunt-tri /g), 8, 'two indications (stop, proceed) per triangle, and no lamp or ring');
    for (const s of net.signals.values()) {
      const m = signalMarkup(html, s.id);
      assert.equal(m.includes('class="signal-ring"'), s.type === 'manual', `${s.id} ring`);
    }
  });

  test('all 63 sections, 15 points and both platforms are rendered', () => {
    assert.equal(count(html, /<g class="section"/g), 63);
    assert.equal(count(html, /<g class="point /g), 15);
    assert.equal(count(html, /class="platform/g), 2);
  });
});

describe('aspects are drawn from the computed aspects', () => {
  test('initial state: manual signals Red, U1 single Yellow, U6 Green', () => {
    const html = render(fresh());
    for (const s of net.signals.values()) if (s.type === 'manual') assert.match(signalMarkup(html, s.id), /class="lamp red lit"/, s.id);
    assert.match(signalMarkup(html, 'U1'), /class="lamp yellow lit"/);
    assert.match(signalMarkup(html, 'U6'), /class="lamp green lit"/);
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
    assert.match(signalMarkup(html, 'U4'), /class="lamp red lit"/);
    assert.match(signalMarkup(html, 'U3'), /class="lamp yellow lit"/);
    const u2 = signalMarkup(html, 'U2');
    assert.equal(count(u2, /class="lamp yellow dy lit"/g), 2);
    assert.match(signalMarkup(html, 'U1'), /class="lamp green lit"/);
  });

  test('the drawn aspect changes when occupancy changes', () => {
    let s = fresh();
    const r = requestRoute(ctx, s, 'U2', 'U3');
    assert.ok(r.ok);
    s = r.state;
    assert.doesNotMatch(signalMarkup(render(s), 'U2'), /class="lamp red lit"/);
    assert.match(signalMarkup(render(setTestOccupancy(s, 'UP4', true)), 'U2'), /class="lamp red lit"/);
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
    assert.equal(count(ok, /class="track route"/g), 5, 'UP5 XW DN7 DN6 DN5');
    const blocked = render(fresh(), { proposalId: 'U3>DR1', proposalBlocked: true });
    assert.equal(count(blocked, /class="track route blocked"/g), 5);
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

describe('Phase 10.5: smooth aspect transitions are drawing-only', () => {
  const litLamps = (markup: string): string[] => [...markup.matchAll(/<circle class="lamp ([a-z\- ]+?) lit"/g)].map((m) => m[1] as string);
  const lampCount = (markup: string): number => count(markup, /<circle class="lamp /g);
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

  /** Signals showing each aspect, found by driving the real interlocking. */
  function stateWithAllAspects(): SignallingState {
    let s = fresh();
    for (const [from, to] of [
      ['U2', 'U3'],
      ['U3', 'U4'],
    ] as const) {
      const r = requestRoute(ctx, s, from, to);
      assert.ok(r.ok);
      s = r.state;
    }
    return s;
  }

  test('every lamp of every head stays mounted, and exactly the logical aspect is lit (1 lamp, or 2 for Double Yellow)', () => {
    const s = stateWithAllAspects();
    const aspects = computeAspects(ctx, s);
    const html = render(s);
    const seen = new Set<string>();
    for (const sig of net.signals.values()) {
      if (sig.type === 'shunting') continue;
      const m = signalMarkup(html, sig.id);
      const a = aspects[sig.id] ?? 'red';
      seen.add(a);
      assert.equal(lampCount(m), 5, `${sig.id}: red, yellow, green and the two Double Yellow lamps are always drawn (stable housing)`);
      const lit = litLamps(m);
      assert.equal(lit.length, a === 'double-yellow' ? 2 : 1, `${sig.id} ${a}`);
      if (a === 'double-yellow') assert.deepEqual(lit, ['yellow dy', 'yellow dy'], 'both Double Yellow lamps share one state, so they fade together');
      else assert.equal(lit[0], a);
    }
    for (const a of ['red', 'yellow', 'double-yellow', 'green']) assert.ok(seen.has(a), `${a} was exercised`);
  });

  test('every transition between the four aspects ends with exactly the new aspect lit, whatever came before (rapid changes leave nothing stale)', () => {
    const aspectsList = ['red', 'yellow', 'double-yellow', 'green'] as const;
    // Rendering is a pure function of the logical aspect: draw every ordered pair, and a rapid chain A→B→C→D→A, and look only at the last picture.
    const s0 = stateWithAllAspects();
    const byAspect = new Map<string, string>();
    const aspects = computeAspects(ctx, s0);
    for (const sig of net.signals.values()) if (sig.type !== 'shunting') byAspect.set(aspects[sig.id] ?? 'red', sig.id);
    for (const from of aspectsList) {
      for (const to of aspectsList) {
        // the same signal drawn "from" then "to": the second picture depends on `to` only
        const m1 = signalMarkup(render(s0), byAspect.get(from) as string);
        const m2 = signalMarkup(render(s0), byAspect.get(to) as string);
        assert.equal(litLamps(m1).length, from === 'double-yellow' ? 2 : 1);
        assert.equal(litLamps(m2).length, to === 'double-yellow' ? 2 : 1);
        assert.ok(!(litLamps(m2).includes('red') && litLamps(m2).length > 1), 'never two incompatible aspects lit at once');
      }
    }
  });

  test('a signal that changes aspect between two renders keeps the same elements (same markup apart from which lamp is lit)', () => {
    let s = fresh();
    const r = requestRoute(ctx, s, 'U2', 'U3');
    assert.ok(r.ok);
    s = r.state;
    const before = signalMarkup(render(s), 'U2');
    const after = signalMarkup(render(setTestOccupancy(s, 'UP4', true)), 'U2');
    assert.notEqual(before, after);
    const strip = (m: string) => m.replace(/ lit"/g, '"').replace(/data-aspect="[a-z-]+"/, '').replace(/<title>.*?<\/title>/, '');
    assert.equal(strip(before), strip(after), 'identical housing and lamps: only `lit`, data-aspect and the tooltip differ, so CSS can fade between them');
  });

  test('shunting signals: both indications are drawn, exactly one is lit (Stop / Proceed)', () => {
    for (const sid of ['S1', 'S4', 'S5', 'S6']) {
      const m = signalMarkup(render(fresh()), sid);
      assert.equal(count(m, /class="shunt-tri stop lit"/g), 1, `${sid} Stop lit`);
      assert.equal(count(m, /class="shunt-tri proceed"/g), 1, `${sid} Proceed drawn but unlit`);
      assert.equal(count(m, /<circle class="lamp/g), 0, 'no lamps on a triangle');
    }
    const r = requestRoute(ctx, fresh(), 'S4', 'SD1-BUF');
    assert.ok(r.ok);
    const m = signalMarkup(render(r.state), 'S4');
    assert.equal(count(m, /class="shunt-tri proceed lit"/g), 1);
    assert.equal(count(m, /class="shunt-tri stop"/g), 1);
  });

  test('stylesheet: unlit lamps are hidden, the fade is 90 ms out then 110 ms in (200 ms), and only without reduced motion', () => {
    assert.match(css, /\.signal \.lamp:not\(\.lit\),\s*\.signal \.shunt-tri:not\(\.lit\) \{\s*opacity: 0;/);
    const block = css.split('@media (prefers-reduced-motion: no-preference) {').find((b) => b.includes('transition: opacity 90ms'));
    assert.ok(block, 'transitions live inside the no-preference media query, so reduced motion switches immediately');
    assert.match(block as string, /transition: opacity 90ms ease-out 0ms;/);
    assert.match(block as string, /transition: opacity 110ms ease-in 90ms;/);
    // nothing outside that query transitions signal lamps
    const outside = css.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}\n/g, '');
    assert.doesNotMatch(outside, /\.signal \.lamp[^{]*\{[^}]*transition/);
    assert.doesNotMatch(css, /animation:[^;]*(lamp|aspect)/);
  });

  test('the logical aspects are untouched by drawing: computeAspects does not depend on anything the diagram renders', () => {
    const s = stateWithAllAspects();
    const before = JSON.stringify(computeAspects(ctx, s));
    render(s);
    render(setTestOccupancy(s, 'UP4', true));
    assert.equal(JSON.stringify(computeAspects(ctx, s)), before, 'rendering has no effect on the logical aspects');
  });
});
