/**
 * Mapping from a train's logical path to the drawing.
 *
 * The engine moves trains in METRES along a list of sections, each entered
 * through a named end. The drawing's polylines have their own (schematic)
 * lengths, so each section is mapped LINEARLY from its logical length in metres
 * to its drawn length: the fraction of the section covered is the fraction of
 * the polyline covered. A train therefore follows corners, diagonals and
 * crossovers exactly as drawn, and cannot jump at a joint.
 *
 * This module is layout-side. It reads the network only for section lengths and
 * the layout only for polylines. Nothing here decides anything about safety.
 */

import type { EndId, Network } from '../engine';
import { dist, EPS, pathFromEnd, pathLength, unit } from './geometry';
import type { LayoutDef, Pt } from './types';

/** One section of a train's path and the end it was entered through. */
export interface PathStepRef {
  readonly section: string;
  readonly enterEnd: EndId;
}

export interface TrackPath {
  /** Logical length of the whole path in metres. */
  readonly totalM: number;
  /** Screen position and heading at a distance along the path. Extrapolates in a straight line outside it. */
  at(m: number): { readonly at: Pt; readonly dir: Pt };
  /** The drawn polyline between two distances (either may be outside the path), in travel order. */
  between(fromM: number, toM: number): Pt[];
}

const lerp = (a: Pt, b: Pt, f: number): Pt => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];

/** Throws if the steps are not a contiguous run of drawn sections. */
export function buildTrackPath(net: Network, layout: LayoutDef, steps: readonly PathStepRef[]): TrackPath {
  if (steps.length === 0) throw new Error('A track path needs at least one section');

  const poly: Pt[] = [];
  const arc: number[] = []; // drawn arc length at each vertex of `poly`
  const knotM: number[] = [0]; // logical metres at each section boundary
  const knotS: number[] = [0]; // drawn arc length at each section boundary

  let drawn = 0;
  let metres = 0;
  for (const step of steps) {
    const section = net.sections.get(step.section);
    if (!section) throw new Error(`Unknown section "${step.section}"`);
    if (!(section.lengthM > 0)) throw new Error(`Section "${step.section}" has no length`);
    const p = pathFromEnd(layout, { section: step.section, end: step.enterEnd });
    const first = p[0];
    const last = poly[poly.length - 1];
    if (last && first && dist(last, first) > EPS) {
      throw new Error(`Path is not contiguous at ${step.section}: previous section ends at [${last}], this one starts at [${first}]`);
    }
    for (let i = 0; i < p.length; i++) {
      const v = p[i];
      if (!v) continue;
      if (i === 0 && last) continue; // shared joint
      if (i > 0) drawn += dist(poly[poly.length - 1] ?? v, v);
      poly.push(v);
      arc.push(drawn);
    }
    metres += section.lengthM;
    knotM.push(metres);
    knotS.push(drawn);
    if (pathLength(p) <= 0) throw new Error(`Section "${step.section}" is drawn with zero length`);
  }

  const totalDrawn = drawn;
  const lastKnot = knotM.length - 1;

  const arcFor = (m: number): number => {
    if (m <= 0) return (m * ((knotS[1] ?? 0) - (knotS[0] ?? 0))) / ((knotM[1] ?? 1) - (knotM[0] ?? 0));
    if (m >= metres) {
      const dm = (knotM[lastKnot] ?? 0) - (knotM[lastKnot - 1] ?? 0);
      const ds = (knotS[lastKnot] ?? 0) - (knotS[lastKnot - 1] ?? 0);
      return totalDrawn + ((m - metres) * ds) / dm;
    }
    let i = 1;
    while (i < lastKnot && (knotM[i] ?? 0) < m) i++;
    const m0 = knotM[i - 1] ?? 0;
    const m1 = knotM[i] ?? 0;
    const s0 = knotS[i - 1] ?? 0;
    const s1 = knotS[i] ?? 0;
    return s0 + ((m - m0) / (m1 - m0)) * (s1 - s0);
  };

  /** Segment index i such that arc[i] <= s <= arc[i+1] (clamped to the polyline). */
  const segmentAt = (s: number): number => {
    let i = 0;
    while (i + 2 < poly.length && (arc[i + 1] ?? 0) <= s) i++;
    return i;
  };

  const atArc = (s: number): { at: Pt; dir: Pt } => {
    const i = segmentAt(s);
    const a = poly[i];
    const b = poly[i + 1];
    if (!a || !b) throw new Error('Degenerate path');
    const u = unit(a, b);
    const s0 = arc[i] ?? 0;
    const seg = (arc[i + 1] ?? 0) - s0;
    if (s < 0) return { at: [a[0] + u[0] * s, a[1] + u[1] * s], dir: u };
    if (s > totalDrawn) return { at: [b[0] + u[0] * (s - totalDrawn), b[1] + u[1] * (s - totalDrawn)], dir: u };
    return { at: lerp(a, b, seg === 0 ? 0 : (s - s0) / seg), dir: u };
  };

  return {
    totalM: metres,
    at: (m) => atArc(arcFor(m)),
    between(fromM, toM) {
      const s0 = arcFor(fromM);
      const s1 = arcFor(toM);
      const lo = Math.min(s0, s1);
      const hi = Math.max(s0, s1);
      const out: Pt[] = [atArc(lo).at];
      for (let i = 0; i < poly.length; i++) {
        const a = arc[i] ?? 0;
        const v = poly[i];
        if (v && a > lo + EPS && a < hi - EPS) out.push(v);
      }
      out.push(atArc(hi).at);
      return s0 <= s1 ? out : out.reverse();
    },
  };
}
