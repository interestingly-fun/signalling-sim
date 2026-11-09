/**
 * Small geometry helpers for polylines. Pure functions, no DOM, no React.
 * Later phases reuse these to move train indicators along section paths.
 */

import type { SectionEnd } from '../engine';
import type { LayoutDef, Pt } from './types';

export const EPS = 0.01;

export function sectionPath(layout: LayoutDef, sectionId: string): readonly Pt[] {
  const path = layout.sections[sectionId];
  if (!path || path.length < 2) throw new Error(`Layout has no polyline for section "${sectionId}"`);
  return path;
}

/** Screen position of one end of a section. */
export function endPoint(layout: LayoutDef, e: SectionEnd): Pt {
  const path = sectionPath(layout, e.section);
  const p = e.end === 'A' ? path[0] : path[path.length - 1];
  if (!p) throw new Error(`Empty polyline for section "${e.section}"`);
  return p;
}

/** The section's polyline, starting at the given end and running into the section. */
export function pathFromEnd(layout: LayoutDef, e: SectionEnd): Pt[] {
  const path = sectionPath(layout, e.section);
  return e.end === 'A' ? [...path] : [...path].reverse();
}

export const dist = (a: Pt, b: Pt): number => Math.hypot(b[0] - a[0], b[1] - a[1]);
export const samePoint = (a: Pt, b: Pt, eps = EPS): boolean => dist(a, b) <= eps;

export function pathLength(path: readonly Pt[]): number {
  let total = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (a && b) total += dist(a, b);
  }
  return total;
}

/** Unit vector pointing from `from` towards `to` ([0,0] if they coincide). */
export function unit(from: Pt, to: Pt): Pt {
  const d = dist(from, to);
  return d === 0 ? [0, 0] : [(to[0] - from[0]) / d, (to[1] - from[1]) / d];
}

/**
 * Unit vector pointing from the given section end INTO the section
 * (along the first segment of the path that starts at that end).
 */
export function directionIntoSection(layout: LayoutDef, e: SectionEnd): Pt {
  const p = pathFromEnd(layout, e);
  const a = p[0];
  const b = p[1];
  if (!a || !b) throw new Error(`Degenerate polyline for section "${e.section}"`);
  return unit(a, b);
}

/** The first `length` units of a path (the whole path if it is shorter). */
export function truncatePath(path: readonly Pt[], length: number): Pt[] {
  const out: Pt[] = [];
  let remaining = length;
  const first = path[0];
  if (!first) return out;
  out.push(first);
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (!a || !b) break;
    const seg = dist(a, b);
    if (seg >= remaining) {
      const f = seg === 0 ? 0 : remaining / seg;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      return out;
    }
    out.push(b);
    remaining -= seg;
  }
  return out;
}

/** Position and travel direction at a distance along a path (clamped). */
export function pointAlong(path: readonly Pt[], distance: number): { at: Pt; dir: Pt } {
  let remaining = Math.max(0, distance);
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (!a || !b) continue;
    const seg = dist(a, b);
    if (remaining <= seg || i + 2 === path.length) {
      const f = seg === 0 ? 0 : Math.min(1, remaining / seg);
      return { at: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], dir: unit(a, b) };
    }
    remaining -= seg;
  }
  const only = path[0];
  if (!only) throw new Error('Empty path');
  return { at: only, dir: [1, 0] };
}

export const midpoint = (path: readonly Pt[]): { at: Pt; dir: Pt } => pointAlong(path, pathLength(path) / 2);

// ---------------------------------------------------------------------------
// Segment intersection (used by layout validation)
// ---------------------------------------------------------------------------

export type SegmentContact =
  | { readonly kind: 'none' }
  | { readonly kind: 'point'; readonly at: Pt }
  | { readonly kind: 'overlap' };

const cross = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;

/**
 * How do segments a1-a2 and b1-b2 touch?
 *  - 'none'    : they do not meet
 *  - 'point'   : they meet in exactly one point (crossing, T-touch or shared endpoint)
 *  - 'overlap' : they are collinear and share a stretch of positive length
 */
export function segmentContact(a1: Pt, a2: Pt, b1: Pt, b2: Pt): SegmentContact {
  const rx = a2[0] - a1[0];
  const ry = a2[1] - a1[1];
  const sx = b2[0] - b1[0];
  const sy = b2[1] - b1[1];
  const denom = cross(rx, ry, sx, sy);
  const qpx = b1[0] - a1[0];
  const qpy = b1[1] - a1[1];

  if (Math.abs(denom) < 1e-9) {
    // parallel
    if (Math.abs(cross(qpx, qpy, rx, ry)) > 1e-6) return { kind: 'none' }; // parallel, not collinear
    const rr = rx * rx + ry * ry;
    if (rr === 0) return { kind: 'none' };
    const t0 = (qpx * rx + qpy * ry) / rr;
    const t1 = t0 + (sx * rx + sy * ry) / rr;
    const lo = Math.max(0, Math.min(t0, t1));
    const hi = Math.min(1, Math.max(t0, t1));
    const len = (hi - lo) * Math.sqrt(rr);
    if (hi < lo - 1e-9) return { kind: 'none' };
    if (len > EPS) return { kind: 'overlap' };
    return { kind: 'point', at: [a1[0] + rx * lo, a1[1] + ry * lo] };
  }

  const t = cross(qpx, qpy, sx, sy) / denom;
  const u = cross(qpx, qpy, rx, ry) / denom;
  const tol = 1e-9;
  if (t < -tol || t > 1 + tol || u < -tol || u > 1 + tol) return { kind: 'none' };
  return { kind: 'point', at: [a1[0] + rx * t, a1[1] + ry * t] };
}
