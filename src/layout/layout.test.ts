import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ashcombeDefinition, buildNetwork } from '../engine';
import { ashcombeLayout, pathLength, pointAlong, segmentContact, truncatePath, validateLayout, type LayoutDef, type Pt } from './index';

const net = buildNetwork(ashcombeDefinition);

/** Copy of the layout with one section redrawn. */
function redraw(sectionId: string, path: readonly Pt[]): LayoutDef {
  return { ...ashcombeLayout, sections: { ...ashcombeLayout.sections, [sectionId]: path } };
}

describe('the Ashcombe drawing agrees with the logical network', () => {
  test('validateLayout reports no problems', () => {
    assert.deepEqual(validateLayout(net, ashcombeLayout), []);
  });

  test('every section is drawn exactly once, and nothing else is', () => {
    assert.deepEqual(Object.keys(ashcombeLayout.sections).sort(), [...net.sections.keys()].sort());
  });

  test('both platforms are drawn alongside their platform sections', () => {
    for (const platform of net.platforms.values()) {
      const rect = ashcombeLayout.platforms[platform.id];
      assert.ok(rect, `${platform.id} has a drawn edge`);
      const path = ashcombeLayout.sections[platform.section];
      assert.ok(path);
      const xs = path.map((p) => p[0]);
      // the platform edge lies within the platform track's x-range
      assert.ok(rect.x >= Math.min(...xs) && rect.x + rect.width <= Math.max(...xs));
    }
  });

  test('geography: branch junction is south-west of the station, not north-east', () => {
    const bj = net.points.get('BJ');
    const plat1 = ashcombeLayout.platforms['PLAT1'];
    const plat2 = ashcombeLayout.platforms['PLAT2'];
    assert.ok(bj && plat1 && plat2);
    const bjPath = ashcombeLayout.sections[bj.toe.section];
    assert.ok(bjPath);
    const bjPos = bj.toe.end === 'A' ? bjPath[0] : bjPath[bjPath.length - 1];
    assert.ok(bjPos);
    const stationCentre: Pt = [plat1.x + plat1.width / 2, (plat1.y + plat2.y) / 2];
    assert.ok(bjPos[0] < stationCentre[0], 'junction is west of the station');
    assert.ok(bjPos[1] > stationCentre[1], 'junction is south of the station');
  });

  test('geography: UP main is north of the DOWN main; Merefield is the south-westernmost boundary', () => {
    const upY = ashcombeLayout.sections['UP1']?.[0]?.[1];
    const downY = ashcombeLayout.sections['DN1']?.[0]?.[1];
    assert.ok(upY !== undefined && downY !== undefined && upY < downY);
    const merefield = net.boundaries.get('M-IO');
    assert.ok(merefield);
    const mp = ashcombeLayout.sections[merefield.at.section]?.[0];
    assert.ok(mp && mp[0] < 100 && mp[1] > (downY ?? 0));
  });
});

describe('validateLayout rejects drawings that disagree with the topology', () => {
  test('a link drawn with a gap', () => {
    const bad = redraw('UP2', [
      [172, 190],
      [390, 190],
    ]);
    assert.ok(validateLayout(net, bad).some((i) => i.includes('UP1.B') && i.includes('shared joint')));
  });

  test('a point whose leg is drawn somewhere else', () => {
    const bad = redraw('LB2', [
      [400, 260],
      [480, 190],
    ]);
    assert.ok(validateLayout(net, bad).some((i) => i.includes('point UJ') && i.includes('junction vertex')));
  });

  test('a point whose leg runs the same way as the toe', () => {
    // UP3 (normal leg of UJ) redrawn running east, past the toe side
    const bad = redraw('UP3', [
      [470, 190],
      [390, 190],
    ]); // reversed: end A now at the point
    const issues = validateLayout(net, bad);
    assert.ok(issues.length > 0);
  });

  test('two tracks that cross visually but are not declared as a crossing', () => {
    // Slide the DOWN main diamond section so it no longer crosses the branch: the declared crossing is not drawn
    const bad = redraw('LBX', [
      [340, 320],
      [345, 300],
    ]);
    const issues = validateLayout(net, bad);
    assert.ok(issues.length > 0);
  });

  test('a track drawn across another without the topology declaring a crossing', () => {
    const bad = redraw('P2', [
      [860, 350],
      [860, 200],
      [1090, 200],
    ]);
    const issues = validateLayout(net, bad);
    assert.ok(issues.some((i) => i.includes('cross') || i.includes('touch') || i.includes('not connected')));
  });

  test('two tracks touching at ends that are not joined in the network', () => {
    // pull UP12 west so its end A lands on UP11's mid-section
    const bad = redraw('UP12', [
      [1370, 190],
      [1540, 190],
    ]);
    assert.ok(validateLayout(net, bad).length > 0);
  });

  test('a missing polyline', () => {
    const sections = { ...ashcombeLayout.sections };
    delete sections['DN5'];
    assert.ok(validateLayout(net, { ...ashcombeLayout, sections }).some((i) => i.includes('DN5') && i.includes('no drawn polyline')));
  });

  test('a declared crossing must be drawn as a crossing', () => {
    const bad = redraw('DX', [
      [345, 300],
      [395, 300],
    ]);
    assert.ok(validateLayout(net, bad).length > 0);
  });
});

describe('moving the drawing never changes the logical network', () => {
  test('buildNetwork does not depend on the layout', () => {
    // The network is built from the definition alone. A distorted layout cannot alter it.
    const before = JSON.stringify(ashcombeDefinition);
    const shifted: LayoutDef = {
      ...ashcombeLayout,
      sections: Object.fromEntries(Object.entries(ashcombeLayout.sections).map(([k, v]) => [k, v.map(([x, y]) => [x + 500, y * 2] as Pt)])),
    };
    // a uniformly shifted/stretched drawing is still consistent...
    assert.deepEqual(validateLayout(net, shifted), []);
    // ...and the network definition is untouched
    assert.equal(JSON.stringify(ashcombeDefinition), before);
    assert.equal(buildNetwork(ashcombeDefinition).sections.size, net.sections.size);
  });
});

describe('geometry helpers', () => {
  test('segmentContact: crossing, touching, overlapping, apart', () => {
    assert.deepEqual(segmentContact([0, 0], [10, 10], [0, 10], [10, 0]), { kind: 'point', at: [5, 5] });
    assert.deepEqual(segmentContact([0, 0], [10, 0], [10, 0], [20, 0]), { kind: 'point', at: [10, 0] });
    assert.deepEqual(segmentContact([0, 0], [10, 0], [5, 0], [20, 0]), { kind: 'overlap' });
    assert.deepEqual(segmentContact([0, 0], [10, 0], [0, 5], [10, 5]), { kind: 'none' });
    assert.deepEqual(segmentContact([0, 0], [10, 0], [20, 5], [20, -5]), { kind: 'none' });
  });

  test('pathLength, truncatePath and pointAlong follow a bent path', () => {
    const path: Pt[] = [
      [0, 0],
      [10, 0],
      [10, 10],
    ];
    assert.equal(pathLength(path), 20);
    assert.deepEqual(truncatePath(path, 15), [
      [0, 0],
      [10, 0],
      [10, 5],
    ]);
    assert.deepEqual(pointAlong(path, 15), { at: [10, 5], dir: [0, 1] });
    assert.deepEqual(pointAlong(path, 100).at, [10, 10]); // clamped to the end
  });
});
