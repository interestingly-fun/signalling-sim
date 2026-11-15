import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { DIFFICULTIES, MAPS, findMap, type MapId } from './maps';
import { initialScreen, navigate, type Screen } from './nav';
import { MainMenu, MapInfo, MapSelect } from './screens';
import { LayoutPreview } from './LayoutPreview';

const only = (ids: MapId[]) => (id: MapId) => ids.includes(id);
const playableAshcombe = only(['ashcombe']);
const noop = () => {};

describe('map data', () => {
  test('three maps in screenshot order with the specified difficulties', () => {
    assert.deepEqual(
      MAPS.map((m) => [m.name, DIFFICULTIES[m.difficulty].label]),
      [
        ['Clumberfield Freight Yard', 'Medium'],
        ['Ashcombe Junction', 'Easy'],
        ['Northbridge Station', 'Intermediate'],
      ],
    );
  });
  test('difficulty colours are yellow / green / orange', () => {
    assert.equal(DIFFICULTIES.medium.colour, '#e6c619');
    assert.equal(DIFFICULTIES.easy.colour, '#7ed321');
    assert.equal(DIFFICULTIES.intermediate.colour, '#e8782a');
  });
  test('only Ashcombe and Northbridge are not flagged planned; every map has a description, bullets and a preview', () => {
    assert.deepEqual(MAPS.filter((m) => !m.planned).map((m) => m.id), ['ashcombe', 'northbridge']);
    for (const m of MAPS) {
      assert.ok(m.description.length > 20);
      assert.ok(m.features.length >= 5);
      assert.ok(m.preview.caption.length > 0);
    }
  });
  test('conceptual previews are labelled as not playable', () => {
    for (const m of MAPS.filter((x) => x.preview.kind === 'conceptual')) assert.match(m.preview.caption, /not a playable map/i);
  });
  test('supplied feature lists are present', () => {
    assert.ok(findMap('ashcombe')!.features.includes('Two ECS sidings'));
    assert.ok(findMap('northbridge')!.features.includes('Six terminating platforms'));
    assert.ok(findMap('clumberfield')!.features.includes('Five parallel yard tracks'));
  });
});

describe('navigation', () => {
  const step = (s: Screen, a: Parameters<typeof navigate>[1]) => navigate(s, a, playableAshcombe);
  test('opens on the main menu', () => assert.equal(initialScreen.name, 'menu'));
  test('menu → select → info → select → menu', () => {
    let s = step(initialScreen, { type: 'start' });
    assert.equal(s.name, 'select');
    s = step(s, { type: 'open', mapId: 'northbridge' });
    assert.deepEqual(s, { name: 'info', mapId: 'northbridge' });
    s = step(s, { type: 'back' });
    assert.equal(s.name, 'select');
    s = step(s, { type: 'back' });
    assert.equal(s.name, 'menu');
  });
  test('Ashcombe can be played from its info page', () => {
    const s = step({ name: 'info', mapId: 'ashcombe' }, { type: 'play', mapId: 'ashcombe' });
    assert.deepEqual(s, { name: 'play', mapId: 'ashcombe' });
  });
  test('Northbridge can be played from its info page', () => {
    const s = navigate({ name: 'info', mapId: 'northbridge' }, { type: 'play', mapId: 'northbridge' }, only(['ashcombe', 'northbridge']));
    assert.deepEqual(s, { name: 'play', mapId: 'northbridge' });
  });
  test('unavailable maps can never reach play, from any screen', () => {
    for (const id of ['clumberfield'] as const) {
      for (const s of [initialScreen, { name: 'select' }, { name: 'info', mapId: id }] as Screen[]) {
        assert.notEqual(step(s, { type: 'play', mapId: id }).name, 'play');
      }
    }
  });
  test('play cannot be reached without the info page, and has no back transition', () => {
    assert.equal(step({ name: 'select' }, { type: 'play', mapId: 'ashcombe' }).name, 'select');
    const playing: Screen = { name: 'play', mapId: 'ashcombe' };
    assert.equal(step(playing, { type: 'back' }), playing);
    assert.equal(step(playing, { type: 'start' }), playing);
  });
  test('a future map becomes playable by predicate only', () => {
    const s = navigate({ name: 'info', mapId: 'northbridge' }, { type: 'play', mapId: 'northbridge' }, only(['northbridge']));
    assert.equal(s.name, 'play');
  });
});

describe('screens (static markup)', () => {
  test('main menu: title and Start button', () => {
    const h = renderToStaticMarkup(<MainMenu onStart={noop} />);
    assert.match(h, /Ashcombe Signalling/);
    assert.match(h, /data-testid="menu-start"/);
    assert.doesNotMatch(h, /<svg/); // no simulation
  });
  test('selection: three real buttons, names and difficulty labels under them', () => {
    const h = renderToStaticMarkup(<MapSelect onOpen={noop} onBack={noop} />);
    assert.equal((h.match(/<button[^>]*class="map-node/g) ?? []).length, 3);
    for (const m of MAPS) {
      assert.match(h, new RegExp(`data-testid="map-${m.id}"`));
      assert.match(h, new RegExp(m.name));
    }
    assert.match(h, /color:#e6c619">Medium/);
    assert.match(h, /color:#7ed321">Easy/);
    assert.match(h, /color:#e8782a">Intermediate/);
  });
  test('info page: Ashcombe is playable, has an enabled Start and a static layout preview', () => {
    const h = renderToStaticMarkup(<MapInfo map={findMap('ashcombe')!} playable onPlay={noop} onBack={noop} />);
    assert.match(h, /Ashcombe Junction/);
    assert.match(h, /Easy/);
    assert.match(h, /Single-track branch towards Merefield/);
    assert.match(h, /data-testid="preview-ashcombe"/);
    assert.doesNotMatch(h, /data-testid="info-start"[^>]*disabled/);
    assert.doesNotMatch(h, /Coming soon/);
  });
  test('info page: Northbridge is playable with an enabled Start and a static layout preview', () => {
    const h = renderToStaticMarkup(<MapInfo map={findMap('northbridge')!} playable onPlay={noop} onBack={noop} />);
    assert.match(h, /Northbridge Station/);
    assert.match(h, /Intermediate/);
    assert.match(h, /data-testid="preview-northbridge"/);
    assert.doesNotMatch(h, /data-testid="info-start"[^>]*disabled/);
    assert.doesNotMatch(h, /Coming soon/);
  });
  for (const id of ['clumberfield'] as const) {
    test(`info page: ${id} is coming soon with a disabled Start and a conceptual preview`, () => {
      const m = findMap(id)!;
      const h = renderToStaticMarkup(<MapInfo map={m} playable={false} onPlay={noop} onBack={noop} />);
      assert.match(h, new RegExp(m.name));
      assert.match(h, /data-testid="info-start"[^>]*disabled/);
      assert.match(h, /Coming soon/);
      assert.match(h, /data-testid="preview-conceptual"/);
      assert.match(h, /not a playable map/i);
    });
  }
  test('previews are static: no signals, trains, lamps, buttons or event handlers', () => {
    for (const m of MAPS) {
      const h = renderToStaticMarkup(<LayoutPreview preview={m.preview} name={m.name} />);
      const drawing = h.replace(/<figcaption.*<\/figcaption>/, '');
      assert.doesNotMatch(drawing, /signal|train|lamp|<button|onclick|<animate/i);
    }
  });
});
