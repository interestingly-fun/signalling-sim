/**
 * Proves that a drawing agrees with the logical network.
 *
 * "Visually connected but not logically connected" (and the reverse) is the
 * failure this guards against. The checks are:
 *
 *  1. Every section has exactly one polyline, and there are no stray polylines.
 *  2. Both ends of every link are drawn at the same spot.
 *  3. All three ends of every point are drawn at the same spot, with the two
 *     legs leaving in different directions on the side opposite the toe.
 *  4. Two drawn sections may only touch or cross when the topology says so:
 *       - touching at ends: only if those ends are joined by a link or share a point;
 *       - crossing mid-section: only if both sections declare `crosses`.
 *     A declared crossing must actually be drawn crossing.
 *  5. Platforms and labelled entities exist in the topology.
 *
 * Returns a list of problems (empty array = consistent).
 */

import type { Network, SectionEnd } from '../engine';
import { directionIntoSection, endPoint, samePoint, segmentContact } from './geometry';
import type { LayoutDef, Pt } from './types';

function logicallyJoined(net: Network, a: SectionEnd, b: SectionEnd): boolean {
  const aa = net.attachmentAt(a);
  const bb = net.attachmentAt(b);
  if (aa.kind === 'link') return aa.other.section === b.section && aa.other.end === b.end;
  if (aa.kind === 'point' && bb.kind === 'point') return aa.point === bb.point;
  return false;
}

/** Which end of the section (if any) a point lies on. */
function endAt(layout: LayoutDef, sectionId: string, p: Pt): 'A' | 'B' | undefined {
  if (samePoint(endPoint(layout, { section: sectionId, end: 'A' }), p)) return 'A';
  if (samePoint(endPoint(layout, { section: sectionId, end: 'B' }), p)) return 'B';
  return undefined;
}

export function validateLayout(net: Network, layout: LayoutDef): string[] {
  const issues: string[] = [];

  // 1. one polyline per section ------------------------------------------------
  for (const id of net.sections.keys()) {
    const path = layout.sections[id];
    if (!path || path.length < 2) issues.push(`section ${id} has no drawn polyline`);
  }
  for (const id of Object.keys(layout.sections)) {
    if (!net.sections.has(id)) issues.push(`layout draws unknown section "${id}"`);
  }
  if (issues.length > 0) return issues; // later checks need every polyline

  // 2. links -------------------------------------------------------------------
  for (const l of net.def.links) {
    if (!samePoint(endPoint(layout, l.a), endPoint(layout, l.b))) {
      issues.push(`link ${l.a.section}.${l.a.end} - ${l.b.section}.${l.b.end} is not drawn as a shared joint`);
    }
  }

  // 3. points ------------------------------------------------------------------
  for (const p of net.points.values()) {
    const toe = endPoint(layout, p.toe);
    const normal = endPoint(layout, p.normal);
    const reverse = endPoint(layout, p.reverse);
    if (!samePoint(toe, normal) || !samePoint(toe, reverse)) {
      issues.push(`point ${p.id}: toe, normal and reverse ends are not drawn at one junction vertex`);
      continue;
    }
    const dToe = directionIntoSection(layout, p.toe);
    const dN = directionIntoSection(layout, p.normal);
    const dR = directionIntoSection(layout, p.reverse);
    const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
    if (dot(dToe, dN) >= 0) issues.push(`point ${p.id}: normal leg is not drawn on the opposite side from the toe`);
    if (dot(dToe, dR) >= 0) issues.push(`point ${p.id}: reverse leg is not drawn on the opposite side from the toe`);
    if (dot(dN, dR) > 0.98) issues.push(`point ${p.id}: normal and reverse legs are drawn along the same line`);
  }

  // 4. touching and crossing ---------------------------------------------------
  const ids = [...net.sections.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const sid = ids[i];
      const tid = ids[j];
      if (sid === undefined || tid === undefined) continue;
      const sp = layout.sections[sid];
      const tp = layout.sections[tid];
      if (!sp || !tp) continue;
      const declared = (net.sections.get(sid)?.crosses ?? []).includes(tid);
      let crossed = false;

      for (let a = 0; a + 1 < sp.length; a++) {
        for (let b = 0; b + 1 < tp.length; b++) {
          const a1 = sp[a];
          const a2 = sp[a + 1];
          const b1 = tp[b];
          const b2 = tp[b + 1];
          if (!a1 || !a2 || !b1 || !b2) continue;
          const c = segmentContact(a1, a2, b1, b2);
          if (c.kind === 'none') continue;
          if (c.kind === 'overlap') {
            issues.push(`sections ${sid} and ${tid} are drawn on top of each other`);
            continue;
          }
          const endS = endAt(layout, sid, c.at);
          const endT = endAt(layout, tid, c.at);
          if (endS && endT) {
            if (!logicallyJoined(net, { section: sid, end: endS }, { section: tid, end: endT })) {
              issues.push(`sections ${sid}.${endS} and ${tid}.${endT} touch on the drawing but are not connected in the network`);
            }
          } else if (declared) {
            crossed = true;
          } else {
            issues.push(`sections ${sid} and ${tid} cross or touch mid-section on the drawing but the network does not declare it`);
          }
        }
      }
      if (declared && !crossed) issues.push(`sections ${sid} and ${tid} are declared as a crossing but are not drawn crossing`);
    }
  }

  // 5. platforms ---------------------------------------------------------------
  for (const id of net.platforms.keys()) {
    if (!layout.platforms[id]) issues.push(`platform ${id} has no drawn platform edge`);
  }
  for (const id of Object.keys(layout.platforms)) {
    if (!net.platforms.has(id)) issues.push(`layout draws unknown platform "${id}"`);
  }
  for (const id of Object.keys(layout.sectionLabelOffsets)) {
    if (!net.sections.has(id)) issues.push(`label offset refers to unknown section "${id}"`);
  }
  for (const id of Object.keys(layout.pointLabelOffsets)) {
    if (!net.points.has(id)) issues.push(`label offset refers to unknown point "${id}"`);
  }
  for (const id of net.points.keys()) {
    if (!layout.pointLabelOffsets[id]) issues.push(`point ${id} has no label offset`);
  }

  return issues;
}
