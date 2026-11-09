import type { Attachment, Network, SectionEnd } from '../engine';

export type Selection =
  | { readonly kind: 'section'; readonly id: string }
  | { readonly kind: 'point'; readonly id: string }
  | { readonly kind: 'signal'; readonly id: string };

export const sameSelection = (a: Selection | null, b: Selection | null): boolean =>
  a !== null && b !== null && a.kind === b.kind && a.id === b.id;

/** Plain-English description of what a section end is attached to. */
export function describeAttachment(net: Network, att: Attachment): string {
  switch (att.kind) {
    case 'link':
      return `joins ${att.other.section} (end ${att.other.end})`;
    case 'point': {
      const p = net.points.get(att.point);
      const role = att.role === 'toe' ? 'toe' : `${att.role} leg`;
      return `point ${att.point} – ${role}${p ? ` (${p.name})` : ''}`;
    }
    case 'boundary': {
      const b = net.boundaries.get(att.boundary);
      if (!b) return `boundary ${att.boundary}`;
      const dir = b.entry && b.exit ? 'entry and exit' : b.entry ? 'entry only' : 'exit only';
      return `boundary to ${b.location} – ${dir}`;
    }
  }
}

export const endLabel = (e: SectionEnd): string => `${e.section}.${e.end}`;
