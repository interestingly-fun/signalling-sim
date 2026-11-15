import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ashcombeDefinition, buildNetwork, createSignallingContext, type EndId } from '../../engine';
import { ashcombeLayout, buildTrackPath, pathLength, type PathStepRef } from '../../layout';
import { trainDrawnLength } from './TrainLayer';
import { BUTTON_STEP, DEFAULT_VIEW, MAX_ZOOM, MIN_ZOOM, clampView, isDefaultView, panBy, toDiagram, zoomAbout, zoomCentre, type Box } from './viewport';

const box: Box = { x: -150, y: 0, w: 1900, h: 560 };

describe('diagram zoom and pan (pure maths)', () => {
  test('zooming about a point keeps the diagram point under it where it was', () => {
    for (const [px, py] of [[400, 200], [1200, 300], [-100, 20]] as const) {
      const before = toDiagram(DEFAULT_VIEW, px, py);
      const v = zoomAbout(DEFAULT_VIEW, box, px, py, 2);
      const after = toDiagram(v, px, py);
      assert.ok(Math.abs(before[0] - after[0]) < 1e-9 && Math.abs(before[1] - after[1]) < 1e-9, `${px},${py}`);
      assert.equal(v.k, 2);
    }
  });

  test('zoom is limited at both ends, and the buttons step by a fixed factor', () => {
    let v = DEFAULT_VIEW;
    for (let i = 0; i < 40; i++) v = zoomCentre(v, box, BUTTON_STEP);
    assert.equal(v.k, MAX_ZOOM);
    for (let i = 0; i < 80; i++) v = zoomCentre(v, box, 1 / BUTTON_STEP);
    assert.equal(v.k, MIN_ZOOM);
    assert.ok(Math.abs(zoomCentre(DEFAULT_VIEW, box, BUTTON_STEP).k - BUTTON_STEP) < 1e-12);
  });

  test('when zoomed in, the drawing cannot be dragged away from the edges of the viewport', () => {
    const v = zoomAbout(DEFAULT_VIEW, box, 800, 280, 3);
    const far = panBy(v, box, 1e6, 1e6);
    // the left/top edge of the drawing cannot pass the left/top edge of the viewport
    assert.ok(far.tx + far.k * box.x <= box.x + 1e-9 && far.ty <= 1e-9);
    const far2 = panBy(v, box, -1e6, -1e6);
    assert.ok(far2.tx + far.k * (box.x + box.w) >= box.x + box.w - 1e-9 && far2.ty + far2.k * box.h >= box.h - 1e-9);
  });

  test('panning moves the drawing by the dragged amount (inside the limits) and never changes the zoom', () => {
    const v = zoomAbout(DEFAULT_VIEW, box, 800, 280, 2);
    const p = panBy(v, box, -30, 10);
    assert.equal(p.k, v.k);
    assert.ok(Math.abs(p.tx - (v.tx - 30)) < 1e-9 && Math.abs(p.ty - (v.ty + 10)) < 1e-9);
  });

  test('the default view is the identity, and reset restores it exactly', () => {
    assert.ok(isDefaultView(DEFAULT_VIEW));
    const v = panBy(zoomAbout(DEFAULT_VIEW, box, 300, 100, 3), box, -50, -20);
    assert.ok(!isDefaultView(v));
    assert.ok(isDefaultView(clampView(DEFAULT_VIEW, box)));
  });

  test('clicks and drags: screen to diagram conversion is the inverse of the view transform', () => {
    const v = panBy(zoomAbout(DEFAULT_VIEW, box, 900, 250, 2.5), box, -40, -15);
    const [cx, cy] = toDiagram(v, 700, 210);
    assert.ok(Math.abs(v.tx + v.k * cx - 700) < 1e-9 && Math.abs(v.ty + v.k * cy - 210) < 1e-9);
  });
});

describe('train symbols have a fixed drawn size', () => {
  const net = buildNetwork(ashcombeDefinition);
  const ctx = createSignallingContext(net);
  const stepsOf = (routeId: string): PathStepRef[] => {
    const info = ctx.info(routeId);
    const first: PathStepRef = { section: info.entrance.section, enterEnd: info.entrance.dir === 'AB' ? 'A' : 'B' };
    return [first, ...[...info.dirs.entries()].map(([section, dir]): PathStepRef => ({ section, enterEnd: (dir === 'AB' ? 'A' : 'B') as EndId }))];
  };

  test('the drawn body is the same length wherever the nose is, however long the section is in metres', () => {
    for (const routeId of ['U2>U3', 'U3>P2E', 'P1E>U6', 'M1>U3']) {
      const path = buildTrackPath(net, ashcombeLayout, stepsOf(routeId));
      const drawn = trainDrawnLength(130);
      for (const frac of [0.05, 0.2, 0.5, 0.75, 0.95]) {
        const body = path.trailing(path.totalM * frac, drawn);
        // along-the-track length of the drawn polyline
        const len = pathLength(body);
        assert.ok(Math.abs(len - drawn) < 0.01 * drawn + 0.5, `${routeId} at ${frac}: ${len.toFixed(1)} vs ${drawn}`);
      }
    }
  });

  test('a longer train is a longer symbol, but only its own length decides it', () => {
    assert.ok(trainDrawnLength(263) > trainDrawnLength(130));
    assert.ok(trainDrawnLength(130) > trainDrawnLength(47));
    assert.ok(trainDrawnLength(47) >= 24, 'never a dot');
  });
});
