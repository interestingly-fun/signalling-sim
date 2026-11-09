/**
 * Graph traversal over the logical network.
 *
 * Trains (and route finding) never look at coordinates: they leave a section
 * through one end, ask what that end is attached to, and enter the next section.
 */

import { otherEnd, type Network } from './network';
import type { PointDef, PointPosition, PointRequirement, SectionEnd } from './types';

/** One possible next move after leaving a section end. */
export type Step =
  | { readonly kind: 'enter'; readonly enter: SectionEnd; readonly requires?: PointRequirement }
  | { readonly kind: 'exit'; readonly boundary: string };

/** May a train leave the section through this end? */
export function canLeave(net: Network, e: SectionEnd): boolean {
  const s = net.sections.get(e.section);
  if (!s) return false;
  return s.traffic === 'both' || (e.end === 'B' ? s.traffic === 'AB' : s.traffic === 'BA');
}

/** May a train enter the section through this end? */
export function canEnter(net: Network, e: SectionEnd): boolean {
  return canLeave(net, { section: e.section, end: otherEnd(e.end) });
}

/**
 * Every move that is physically possible after leaving a section through `leaving`.
 *
 *  - link:           exactly one step, no point requirement.
 *  - point, via toe: two steps (normal leg / reverse leg), each requiring that position.
 *  - point, via leg: one step onto the toe, requiring that leg's position (trailing move).
 *  - boundary:       an exit step if the boundary permits leaving.
 *
 * Steps into a section that does not allow traffic in that direction are dropped.
 */
export function stepsFrom(net: Network, leaving: SectionEnd): Step[] {
  const att = net.attachmentAt(leaving);
  switch (att.kind) {
    case 'link':
      return canEnter(net, att.other) ? [{ kind: 'enter', enter: att.other }] : [];
    case 'boundary': {
      const b = net.boundaries.get(att.boundary);
      return b?.exit ? [{ kind: 'exit', boundary: b.id }] : [];
    }
    case 'point': {
      const p = net.points.get(att.point);
      if (!p) return [];
      if (att.role === 'toe') {
        const steps: Step[] = [];
        if (canEnter(net, p.normal)) steps.push({ kind: 'enter', enter: p.normal, requires: { point: p.id, position: 'normal' } });
        if (canEnter(net, p.reverse)) steps.push({ kind: 'enter', enter: p.reverse, requires: { point: p.id, position: 'reverse' } });
        return steps;
      }
      return canEnter(net, p.toe) ? [{ kind: 'enter', enter: p.toe, requires: { point: p.id, position: att.role } }] : [];
    }
  }
}

/** Which two section ends are connected through this point in the given position. */
export function pointConnection(point: PointDef, position: PointPosition): { toe: SectionEnd; leg: SectionEnd } {
  return { toe: point.toe, leg: position === 'normal' ? point.normal : point.reverse };
}

/**
 * Where does a train that leaves `leaving` end up, given the CURRENT point
 * positions? Returns undefined if the way is not available (a facing/trailing
 * move through a point that is set the other way, or no exit permitted).
 */
export function nextWithPositions(
  net: Network,
  leaving: SectionEnd,
  positions: Readonly<Record<string, PointPosition>>,
): { kind: 'enter'; enter: SectionEnd } | { kind: 'exit'; boundary: string } | undefined {
  for (const step of stepsFrom(net, leaving)) {
    if (step.kind === 'exit') return step;
    if (!step.requires || positions[step.requires.point] === step.requires.position) return { kind: 'enter', enter: step.enter };
  }
  return undefined;
}
