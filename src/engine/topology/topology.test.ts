import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ashcombeDefinition,
  buildNetwork,
  createInitialState,
  deriveRoutes,
  nextWithPositions,
  NetworkValidationError,
  pointConnection,
  reviewSetOccupied,
  reviewSetPointPosition,
  stepsFrom,
  validateNetworkDef,
  type DerivedRoute,
  type NetworkDef,
  type PointPosition,
  type SectionEnd,
} from '../index';

const net = buildNetwork(ashcombeDefinition);
const routes = deriveRoutes(net);
const sectionEnd = (section: string, end: 'A' | 'B'): SectionEnd => ({ section, end });

/** Clone the definition with a modification, to prove the validator rejects broken networks. */
type DeepWritable<T> = { -readonly [K in keyof T]: DeepWritable<T[K]> };

function mutate(fn: (d: DeepWritable<NetworkDef>) => void): NetworkDef {
  const copy = JSON.parse(JSON.stringify(ashcombeDefinition)) as DeepWritable<NetworkDef>;
  fn(copy);
  return copy as NetworkDef;
}

describe('Ashcombe Junction network: required content', () => {
  test('has two platforms, each on its own platform track', () => {
    assert.equal(net.platforms.size, 2);
    for (const p of net.platforms.values()) assert.equal(net.sections.get(p.section)?.platform, p.id);
  });

  test('has boundaries for Northbridge (UP), Westford (DOWN) and Merefield (BRANCH)', () => {
    const locations = new Set([...net.boundaries.values()].map((b) => b.location));
    assert.deepEqual([...locations].sort(), ['Merefield', 'Northbridge', 'Westford']);
    for (const loc of locations) {
      const bs = [...net.boundaries.values()].filter((b) => b.location === loc);
      assert.ok(bs.some((b) => b.entry), `${loc} needs an entry`);
      assert.ok(bs.some((b) => b.exit), `${loc} needs an exit`);
    }
  });

  test('has automatic and manual signals', () => {
    const types = new Set([...net.signals.values()].map((s) => s.type));
    assert.ok(types.has('automatic'));
    assert.ok(types.has('manual'));
    assert.ok([...net.signals.values()].filter((s) => s.type === 'automatic').length >= 3, '"several" automatic signals');
  });

  test('every point is protected by manual signals, never by automatic ones alone', () => {
    // An automatic signal must not be the only thing in front of a facing point:
    // check that no route that starts at an automatic signal passes a facing point choice.
    for (const r of routes) {
      const from = net.signals.get(r.from);
      if (from?.type !== 'automatic') continue;
      // an automatic signal's routes must be unambiguous: only one route leaves it
      assert.equal(routes.filter((x) => x.from === r.from).length, 1, `automatic signal ${r.from} must have exactly one route`);
    }
  });

  test('contains a branch junction, a crossover, and a diamond crossing', () => {
    assert.ok(net.junctions.has('BRANCH-JN'));
    assert.ok(net.junctions.has('WEST-XOVER'));
    assert.equal(net.sections.get('DX')?.crosses?.[0], 'LBX');
    assert.equal(net.sections.get('LBX')?.crosses?.[0], 'DX');
  });
});

describe('network validation (no tracks that are only visually connected)', () => {
  test('the Ashcombe definition is valid', () => {
    assert.deepEqual(validateNetworkDef(ashcombeDefinition), []);
  });

  test('a dangling section end is rejected', () => {
    const bad = mutate((d) => {
      d.links = d.links.filter((l) => !(l.a.section === 'UP1' && l.b.section === 'UP2'));
    });
    assert.ok(validateNetworkDef(bad).some((i) => i.includes('UP1.B') && i.includes('not attached')));
    assert.throws(() => buildNetwork(bad), NetworkValidationError);
  });

  test('attaching one end twice is rejected', () => {
    const bad = mutate((d) => {
      d.links.push({ a: sectionEnd('UP1', 'B'), b: sectionEnd('UP3', 'A') });
    });
    assert.ok(validateNetworkDef(bad).some((i) => i.includes('attached twice')));
  });

  test('references to unknown sections are rejected', () => {
    const bad = mutate((d) => {
      const p = d.points[0];
      assert.ok(p);
      p.reverse = sectionEnd('NOPE', 'A');
    });
    assert.ok(validateNetworkDef(bad).some((i) => i.includes('unknown section "NOPE"')));
  });

  test('an asymmetric crossing is rejected', () => {
    const bad = mutate((d) => {
      const lbx = d.sections.find((s) => s.id === 'LBX');
      assert.ok(lbx);
      delete lbx.crosses;
    });
    assert.ok(validateNetworkDef(bad).some((i) => i.includes('not symmetric')));
  });

  test('a signal facing a direction the section forbids is rejected', () => {
    const bad = mutate((d) => {
      const s = d.signals.find((x) => x.id === 'U1');
      assert.ok(s);
      s.at = sectionEnd('UP1', 'A'); // UP1 is eastbound only
    });
    assert.ok(validateNetworkDef(bad).some((i) => i.includes('signal U1 faces a direction')));
  });

  test('a boundary that its section cannot serve is rejected', () => {
    const bad = mutate((d) => {
      const b = d.boundaries.find((x) => x.id === 'N-IN');
      assert.ok(b);
      b.exit = true; // DN1 is westbound only: cannot leave at end B
    });
    assert.ok(validateNetworkDef(bad).some((i) => i.includes('boundary N-IN') && i.includes('leave')));
  });

  test('duplicate IDs are rejected', () => {
    const bad = mutate((d) => {
      const first = d.sections[0];
      assert.ok(first);
      d.sections.push({ ...first });
    });
    assert.ok(validateNetworkDef(bad).some((i) => i.includes('duplicate section id "UP1"')));
  });
});

describe('traversal: points decide which connections exist', () => {
  test('leaving through a point toe offers normal and reverse, each requiring that position', () => {
    // UJ's toe is UP4.A; a westbound move is not allowed, so use PW1 (toe = UP7.B, facing for eastbound)
    const steps = stepsFrom(net, sectionEnd('UP7', 'B'));
    assert.equal(steps.length, 2);
    const reqs = steps.map((s) => (s.kind === 'enter' ? `${s.enter.section}:${s.requires?.position}` : 'exit')).sort();
    assert.deepEqual(reqs, ['P1W:reverse', 'UP8:normal']);
  });

  test('a trailing move (from a leg onto the toe) requires that leg to be selected', () => {
    // From P1E (reverse leg of PE1) onto UP10 (the toe): needs PE1 reverse.
    const steps = stepsFrom(net, sectionEnd('P1E', 'B'));
    assert.equal(steps.length, 1);
    const step = steps[0];
    assert.ok(step && step.kind === 'enter');
    assert.equal(step.enter.section, 'UP10');
    assert.deepEqual(step.requires, { point: 'PE1', position: 'reverse' });
  });

  test('nextWithPositions follows the current point position', () => {
    const state = createInitialState(net);
    const leaving = sectionEnd('UP7', 'B');
    const normal = nextWithPositions(net, leaving, state.pointPositions);
    assert.deepEqual(normal, { kind: 'enter', enter: sectionEnd('UP8', 'A') });
    const flipped = reviewSetPointPosition(state, 'PW1', 'reverse');
    const reverse = nextWithPositions(net, leaving, flipped.pointPositions);
    assert.deepEqual(reverse, { kind: 'enter', enter: sectionEnd('P1W', 'A') });
  });

  test('a trailing move through a point set the wrong way is not available', () => {
    const state = createInitialState(net); // PE1 normal
    // P1E.B attaches to PE1's reverse leg; with PE1 normal the move onto UP10 must be blocked
    assert.equal(nextWithPositions(net, sectionEnd('P1E', 'B'), state.pointPositions), undefined);
    const set = reviewSetPointPosition(state, 'PE1', 'reverse');
    assert.deepEqual(nextWithPositions(net, sectionEnd('P1E', 'B'), set.pointPositions), { kind: 'enter', enter: sectionEnd('UP10', 'A') });
  });

  test('pointConnection reports toe + selected leg', () => {
    const pw1 = net.points.get('PW1');
    assert.ok(pw1);
    assert.deepEqual(pointConnection(pw1, 'normal'), { toe: pw1.toe, leg: pw1.normal });
    assert.deepEqual(pointConnection(pw1, 'reverse'), { toe: pw1.toe, leg: pw1.reverse });
  });

  test('traffic directions are respected (no eastbound movement onto westbound-only track)', () => {
    // EXD normal leg is DN3 (westbound only): an eastbound move from DN4 must not enter it.
    const steps = stepsFrom(net, sectionEnd('DN4', 'B'));
    const entered = steps.flatMap((s) => (s.kind === 'enter' ? [s.enter.section] : []));
    assert.deepEqual(entered, ['XE']);
  });

  test('exits are only offered at boundaries that permit leaving', () => {
    assert.deepEqual(stepsFrom(net, sectionEnd('UPE1', 'B')), [{ kind: 'exit', boundary: 'N-OUT' }]);
    assert.deepEqual(stepsFrom(net, sectionEnd('DNE2', 'B')), []); // N-IN is entry only
    assert.deepEqual(stepsFrom(net, sectionEnd('UPW2', 'A')), []); // W-IN is entry only
  });
});

describe('derived route table', () => {
  const ids = routes.map((r) => r.id).sort();

  test('golden list of signal-to-signal routes (review this when the layout changes)', () => {
    assert.deepEqual(ids, [
      'D1>D2',
      'D2>D3',
      'D2>P2W',
      'D3>D4',
      'D3>M2',
      'D4>DW1',
      'DE1>D1',
      'DE2>DE1',
      'DR1>U6',
      'DW1>DW2',
      'DW2>W-OUT',
      'M1>U3',
      'M2>MX1',
      'MW1>M1',
      'MW2>MW1',
      'MW3>MW2',
      'MX1>MX2',
      'MX2>M-IO',
      'P1E>U6',
      'P2E>U6',
      'P2W>D4',
      'P2W>M2',
      'U1>U2',
      'U2>U3',
      'U3>DR1',
      'U3>P2E',
      'U3>U4',
      'U4>P1E',
      'U4>U5',
      'U5>U6',
      'U6>UE1',
      'UE1>N-OUT',
      'UW1>U1',
      'UW2>UW1',
    ]);
  });

  test('route IDs are unique', () => {
    assert.equal(new Set(ids).size, ids.length);
  });

  test('every route starts at a real signal and ends at a real signal or boundary', () => {
    for (const r of routes) {
      assert.ok(net.signals.has(r.from), `${r.id} starts at unknown signal`);
      assert.ok(r.toKind === 'signal' ? net.signals.has(r.to) : net.boundaries.has(r.to), `${r.id} ends at unknown destination`);
      assert.ok(r.sections.length > 0);
    }
  });

  /** Replays a derived route using ONLY the traversal engine and point positions. */
  function replay(route: DerivedRoute, overrides: Record<string, PointPosition> = {}) {
    const positions: Record<string, PointPosition> = { ...createInitialState(net).pointPositions };
    for (const r of route.points) positions[r.point] = r.position;
    Object.assign(positions, overrides);

    const start = net.signals.get(route.from);
    assert.ok(start);
    const visited: string[] = [];
    let leaving: SectionEnd = start.at;
    for (let guard = 0; guard < 60; guard++) {
      const next = nextWithPositions(net, leaving, positions);
      if (!next) return { visited, blocked: true as const };
      if (next.kind === 'exit') return { visited, blocked: false as const, exit: next.boundary };
      visited.push(next.enter.section);
      leaving = { section: next.enter.section, end: next.enter.end === 'A' ? 'B' : 'A' };
      if (net.signalLeaving(leaving)) return { visited, blocked: false as const, signal: net.signalLeaving(leaving)?.id };
    }
    throw new Error('replay did not terminate');
  }

  test('with the required point positions, trains following the graph take exactly the derived route', () => {
    for (const r of routes) {
      const result = replay(r);
      assert.equal(result.blocked, false, `${r.id} blocked`);
      assert.deepEqual(result.visited, [...r.sections], `${r.id} section sequence`);
      if (r.toKind === 'signal') assert.equal('signal' in result ? result.signal : undefined, r.to, `${r.id} destination`);
      else assert.equal('exit' in result ? result.exit : undefined, r.to, `${r.id} exit`);
    }
  });

  test('flipping any required point away from the route makes the derived path impossible', () => {
    for (const r of routes) {
      for (const req of r.points) {
        const wrong: PointPosition = req.position === 'normal' ? 'reverse' : 'normal';
        const result = replay(r, { [req.point]: wrong });
        assert.notDeepEqual(result.visited, [...r.sections], `${r.id} must not survive ${req.point} being ${wrong}`);
      }
    }
  });

  test('every section is on a route, except the two outermost entry approach sections before UW2 and DE2', () => {
    const used = new Set(routes.flatMap((r) => r.sections));
    const unused = [...net.sections.keys()].filter((s) => !used.has(s)).sort();
    assert.deepEqual(unused, ['DNE2', 'UPW2']);
    for (const s of unused) {
      const entry = [...net.boundaries.values()].find((b) => b.entry && b.at.section === s);
      assert.ok(entry, `${s} should be an entry approach section`);
    }
  });

  test('every point is used in both positions by at least one route', () => {
    for (const p of net.points.keys()) {
      const positions = new Set(routes.flatMap((r) => r.points.filter((x) => x.point === p).map((x) => x.position)));
      assert.ok(positions.has('normal'), `${p} never used normal`);
      assert.ok(positions.has('reverse'), `${p} never used reverse`);
    }
  });

  test('the diamond only crosses: no route ever passes from DX to LBX or back', () => {
    for (const r of routes) {
      for (let i = 0; i + 1 < r.sections.length; i++) {
        const pair = [r.sections[i], r.sections[i + 1]].sort().join('|');
        assert.notEqual(pair, 'DX|LBX', `${r.id} wrongly turns across the diamond`);
      }
    }
    // and both movements that use the diamond exist
    assert.ok(routes.some((r) => r.sections.includes('DX')));
    assert.ok(routes.some((r) => r.sections.includes('LBX')));
  });
});

describe('which journeys the layout supports (reachability over the route table)', () => {
  /** All exit boundaries and platforms reachable by chaining routes from a signal. */
  function reach(startSignal: string) {
    const seenSignals = new Set<string>([startSignal]);
    const exits = new Set<string>();
    const platforms = new Set<string>();
    const queue = [startSignal];
    while (queue.length > 0) {
      const cur = queue.pop();
      if (cur === undefined) break;
      for (const r of routes.filter((x) => x.from === cur)) {
        for (const sid of r.sections) {
          const p = net.sections.get(sid)?.platform;
          if (p) platforms.add(p);
        }
        if (r.toKind === 'boundary') exits.add(r.to);
        else if (!seenSignals.has(r.to)) {
          seenSignals.add(r.to);
          queue.push(r.to);
        }
      }
    }
    return { exits: [...exits].sort(), platforms: [...platforms].sort() };
  }

  test('Westford (UP main entry) -> Northbridge only; both platforms reachable', () => {
    const r = reach('U1');
    assert.deepEqual(r.exits, ['N-OUT']);
    assert.deepEqual(r.platforms, ['PLAT1', 'PLAT2']);
  });

  test('Northbridge (DOWN main entry) -> Westford or Merefield; Platform 2 reachable', () => {
    const r = reach('D1');
    assert.deepEqual(r.exits, ['M-IO', 'W-OUT']);
    assert.deepEqual(r.platforms, ['PLAT2']);
  });

  test('Merefield -> Northbridge only; both platforms reachable', () => {
    const r = reach('M1');
    assert.deepEqual(r.exits, ['N-OUT']);
    assert.deepEqual(r.platforms, ['PLAT1', 'PLAT2']);
  });

  test('Westford <-> Merefield is impossible (it would need a reversal)', () => {
    assert.ok(!reach('U1').exits.includes('M-IO'));
    assert.ok(!reach('M1').exits.includes('W-OUT'));
  });
});

describe('initial state', () => {
  test('all points normal and all sections clear', () => {
    const s = createInitialState(net);
    assert.equal(Object.keys(s.pointPositions).length, net.points.size);
    assert.ok(Object.values(s.pointPositions).every((p) => p === 'normal'));
    assert.equal(Object.keys(s.sectionOccupancy).length, net.sections.size);
    assert.ok(Object.values(s.sectionOccupancy).every((o) => o === null));
  });

  test('state updates are immutable', () => {
    const s0 = createInitialState(net);
    const s1 = reviewSetPointPosition(s0, 'BJ', 'reverse');
    const s2 = reviewSetOccupied(s1, 'UP4', true);
    assert.equal(s0.pointPositions['BJ'], 'normal');
    assert.equal(s1.pointPositions['BJ'], 'reverse');
    assert.equal(s1.sectionOccupancy['UP4'], null);
    assert.notEqual(s2.sectionOccupancy['UP4'], null);
  });

  test('updating an unknown point or section throws', () => {
    const s = createInitialState(net);
    assert.throws(() => reviewSetPointPosition(s, 'NOPE', 'reverse'));
    assert.throws(() => reviewSetOccupied(s, 'NOPE', true));
  });
});
