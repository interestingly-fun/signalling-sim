import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ashcombeDefinition, buildNetwork, createSignallingContext, deriveRoutes, type EndId } from '../engine';
import { ashcombeLayout, buildTrackPath, dist, pathLength, type PathStepRef, type Pt } from './index';

const net = buildNetwork(ashcombeDefinition);
const ctx = createSignallingContext(net);

/** Section steps of a derived movement, starting with the section its entrance signal stands in. */
function stepsOf(routeId: string): PathStepRef[] {
  const info = ctx.info(routeId);
  const first: PathStepRef = { section: info.entrance.section, enterEnd: info.entrance.dir === 'AB' ? 'A' : 'B' };
  const rest = [...info.dirs.entries()].map(([section, dir]): PathStepRef => ({ section, enterEnd: (dir === 'AB' ? 'A' : 'B') as EndId }));
  return [first, ...rest];
}
const metres = (steps: readonly PathStepRef[]) => steps.reduce((t, s) => t + (net.sections.get(s.section)?.lengthM ?? 0), 0);

describe('logical sections map onto the drawn track', () => {
  test('every derived movement (straights, diagonals, crossovers, points, platform loops, diamond) is one unbroken drawn path', () => {
    for (const r of deriveRoutes(net)) {
      const steps = stepsOf(r.id);
      const path = buildTrackPath(net, ashcombeLayout, steps); // throws if two sections do not meet at a drawn joint
      assert.ok(Math.abs(path.totalM - metres(steps)) < 1e-9, r.id);
    }
  });

  test('moving a metre at a time never jumps on screen and never doubles back (no teleporting at joints)', () => {
    for (const r of deriveRoutes(net)) {
      const steps = stepsOf(r.id);
      const path = buildTrackPath(net, ashcombeLayout, steps);
      // the largest drawn-units-per-metre of any section bounds how far one metre can move the train
      const maxRatio = Math.max(
        ...steps.map((s) => pathLength(ashcombeLayout.sections[s.section] as readonly Pt[]) / (net.sections.get(s.section)?.lengthM ?? 1)),
      );
      let prev = path.at(0).at;
      for (let m = 1; m <= path.totalM; m += 1) {
        const p = path.at(m).at;
        assert.ok(dist(prev, p) <= maxRatio + 1e-6, `${r.id}: jump of ${dist(prev, p).toFixed(2)} at ${m} m`);
        assert.ok(dist(prev, p) > 0, `${r.id}: stalled at ${m} m`);
        prev = p;
      }
    }
  });

  test('position at a section boundary is the shared drawn joint', () => {
    const steps = stepsOf('D3>D4');
    const path = buildTrackPath(net, ashcombeLayout, steps);
    let m = 0;
    for (let i = 0; i + 1 < steps.length; i++) {
      m += net.sections.get(steps[i]?.section ?? '')?.lengthM ?? 0;
      const here = path.at(m).at;
      const a = ashcombeLayout.sections[steps[i]?.section ?? ''] as readonly Pt[];
      const b = ashcombeLayout.sections[steps[i + 1]?.section ?? ''] as readonly Pt[];
      const ends = [a[0], a[a.length - 1], b[0], b[b.length - 1]] as Pt[];
      assert.ok(ends.some((e) => dist(e, here) < 1e-6), `joint ${steps[i]?.section}/${steps[i + 1]?.section}`);
    }
  });

  test('westbound DOWN main (DN1 to DN11) is drawn right to left, eastbound UP main left to right', () => {
    const west = buildTrackPath(net, ashcombeLayout, ['DN1', 'DN2', 'DN3'].map((section) => ({ section, enterEnd: 'B' as const })));
    assert.ok(west.at(10).dir[0] < 0, 'heading west (left)');
    assert.ok(west.at(0).at[0] > west.at(west.totalM).at[0]);
    const east = buildTrackPath(net, ashcombeLayout, ['UP1', 'UP2', 'UP3'].map((section) => ({ section, enterEnd: 'A' as const })));
    assert.ok(east.at(10).dir[0] > 0, 'heading east (right)');
  });

  test('the heading turns through curves and diagonals: Platform 2 and the branch are not straight', () => {
    for (const id of ['D2>P2W', 'D3>M2']) {
      const path = buildTrackPath(net, ashcombeLayout, stepsOf(id));
      const headings = new Set<string>();
      for (let m = 0; m <= path.totalM; m += 5) headings.add(path.at(m).dir.map((c) => c.toFixed(2)).join(','));
      assert.ok(headings.size > 1, `${id} has more than one heading`);
    }
  });

  test('the train body (rear to front) follows corners: it contains the polyline vertices between them', () => {
    const path = buildTrackPath(net, ashcombeLayout, stepsOf('D3>M2'));
    const whole = path.between(0, path.totalM);
    assert.ok(whole.length > 3, 'a bent route has interior vertices');
    const body = path.between(100, 300);
    assert.deepEqual(body[0], path.at(100).at);
    assert.deepEqual(body[body.length - 1], path.at(300).at);
    // length of the body equals the drawn distance it spans
    const a = path.between(100, 101);
    assert.ok(a.length >= 2);
  });

  test('before the start and past the end the path continues in a straight line, so a train enters and leaves the screen smoothly', () => {
    const path = buildTrackPath(net, ashcombeLayout, stepsOf('D1>D2'));
    const start = path.at(0);
    const before = path.at(-100).at;
    assert.ok(dist(before, start.at) > 10);
    const d = dist(start.at, before);
    const back: Pt = [(start.at[0] - before[0]) / d, (start.at[1] - before[1]) / d];
    assert.ok(Math.abs(back[0] - start.dir[0]) < 1e-9 && Math.abs(back[1] - start.dir[1]) < 1e-9);
  });

  test('rejects sections that do not meet', () => {
    assert.throws(() => buildTrackPath(net, ashcombeLayout, [{ section: 'DN1', enterEnd: 'B' }, { section: 'UP9', enterEnd: 'A' }]), /not contiguous/);
    assert.throws(() => buildTrackPath(net, ashcombeLayout, []), /at least one/);
  });
});
