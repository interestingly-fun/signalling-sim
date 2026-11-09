/**
 * Builds an indexed, validated Network from a NetworkDef.
 *
 * Validation is strict on purpose: "tracks that are only visually connected"
 * are impossible, because a network with an unattached, doubly-attached or
 * dangling section end does not load.
 */

import type {
  Attachment,
  BoundaryDef,
  EndId,
  JunctionDef,
  NetworkDef,
  PlatformDef,
  PointDef,
  SectionDef,
  SectionEnd,
  SignalDef,
} from './types';

export const endKey = (e: SectionEnd): string => `${e.section}.${e.end}`;
export const otherEnd = (e: EndId): EndId => (e === 'A' ? 'B' : 'A');

export class NetworkValidationError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid railway network:\n - ${issues.join('\n - ')}`);
    this.name = 'NetworkValidationError';
    this.issues = issues;
  }
}

export interface Network {
  readonly def: NetworkDef;
  readonly sections: ReadonlyMap<string, SectionDef>;
  readonly points: ReadonlyMap<string, PointDef>;
  readonly signals: ReadonlyMap<string, SignalDef>;
  readonly platforms: ReadonlyMap<string, PlatformDef>;
  readonly boundaries: ReadonlyMap<string, BoundaryDef>;
  readonly junctions: ReadonlyMap<string, JunctionDef>;
  /** What the given section end is attached to. */
  attachmentAt(end: SectionEnd): Attachment;
  /** The signal (if any) governing trains that leave through the given section end. */
  signalLeaving(end: SectionEnd): SignalDef | undefined;
}

function indexById<T extends { id: string }>(items: readonly T[], what: string, issues: string[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    if (map.has(item.id)) issues.push(`duplicate ${what} id "${item.id}"`);
    map.set(item.id, item);
  }
  return map;
}

/** Returns every problem found in the definition (empty array = valid). */
export function validateNetworkDef(def: NetworkDef): string[] {
  const issues: string[] = [];
  const sections = indexById(def.sections, 'section', issues);
  const points = indexById(def.points, 'point', issues);
  indexById(def.signals, 'signal', issues);
  const platforms = indexById(def.platforms, 'platform', issues);
  indexById(def.boundaries, 'boundary', issues);
  indexById(def.junctions, 'junction', issues);

  const checkEnd = (e: SectionEnd, ctx: string): boolean => {
    if (!sections.has(e.section)) {
      issues.push(`${ctx} refers to unknown section "${e.section}"`);
      return false;
    }
    if (e.end !== 'A' && e.end !== 'B') {
      issues.push(`${ctx} has invalid end "${String(e.end)}"`);
      return false;
    }
    return true;
  };

  // --- attachments: every end attached exactly once --------------------------------
  const attached = new Map<string, string>();
  const attach = (e: SectionEnd, what: string) => {
    if (!checkEnd(e, what)) return;
    const k = endKey(e);
    const prev = attached.get(k);
    if (prev !== undefined) issues.push(`section end ${k} is attached twice: ${prev} and ${what}`);
    else attached.set(k, what);
  };

  def.links.forEach((l, i) => {
    attach(l.a, `link #${i}`);
    attach(l.b, `link #${i}`);
    if (l.a.section === l.b.section) issues.push(`link #${i} joins section "${l.a.section}" to itself`);
  });
  for (const p of def.points) {
    attach(p.toe, `point ${p.id} (toe)`);
    attach(p.normal, `point ${p.id} (normal)`);
    attach(p.reverse, `point ${p.id} (reverse)`);
    const ids = new Set([p.toe.section, p.normal.section, p.reverse.section]);
    if (ids.size !== 3) issues.push(`point ${p.id}: toe, normal and reverse must be three different sections`);
  }
  for (const b of def.boundaries) {
    attach(b.at, `boundary ${b.id}`);
    if (!b.entry && !b.exit) issues.push(`boundary ${b.id} is neither an entry nor an exit`);
  }
  for (const s of def.sections) {
    for (const e of ['A', 'B'] as const) {
      if (!attached.has(`${s.id}.${e}`)) issues.push(`section end ${s.id}.${e} is not attached to anything (dangling track)`);
    }
  }

  // --- traffic directions ------------------------------------------------------------
  const canLeave = (e: SectionEnd): boolean => {
    const s = sections.get(e.section);
    if (!s) return false;
    return s.traffic === 'both' || (e.end === 'B' ? s.traffic === 'AB' : s.traffic === 'BA');
  };
  const canEnter = (e: SectionEnd): boolean => canLeave({ section: e.section, end: otherEnd(e.end) });

  for (const b of def.boundaries) {
    if (b.entry && !canEnter(b.at)) issues.push(`boundary ${b.id}: section ${b.at.section} does not allow trains to enter at end ${b.at.end}`);
    if (b.exit && !canLeave(b.at)) issues.push(`boundary ${b.id}: section ${b.at.section} does not allow trains to leave at end ${b.at.end}`);
  }

  // --- signals -----------------------------------------------------------------------
  const signalEnds = new Set<string>();
  for (const s of def.signals) {
    if (!checkEnd(s.at, `signal ${s.id}`)) continue;
    if (!canLeave(s.at)) issues.push(`signal ${s.id} faces a direction that section ${s.at.section} does not allow`);
    const k = endKey(s.at);
    if (signalEnds.has(k)) issues.push(`two signals govern movements leaving ${k}`);
    signalEnds.add(k);
  }

  // --- platforms ---------------------------------------------------------------------
  for (const p of def.platforms) {
    const s = sections.get(p.section);
    if (!s) issues.push(`platform ${p.id} refers to unknown section "${p.section}"`);
    else if (s.platform !== p.id) issues.push(`platform ${p.id}: section ${s.id} does not declare platform "${p.id}"`);
  }
  for (const s of def.sections) {
    if (s.platform !== undefined && !platforms.has(s.platform)) issues.push(`section ${s.id} declares unknown platform "${s.platform}"`);
  }

  // --- crossings ---------------------------------------------------------------------
  for (const s of def.sections) {
    for (const other of s.crosses ?? []) {
      const o = sections.get(other);
      if (!o) issues.push(`section ${s.id} crosses unknown section "${other}"`);
      else if (!(o.crosses ?? []).includes(s.id)) issues.push(`crossing is not symmetric: ${s.id} crosses ${other} but not vice versa`);
    }
  }

  // --- junctions ---------------------------------------------------------------------
  for (const j of def.junctions) {
    for (const pid of j.points) if (!points.has(pid)) issues.push(`junction ${j.id} refers to unknown point "${pid}"`);
    for (const sid of j.sections ?? []) if (!sections.has(sid)) issues.push(`junction ${j.id} refers to unknown section "${sid}"`);
    for (const [x, y] of j.crossings ?? []) {
      const sx = sections.get(x);
      if (!sx || !sections.has(y)) issues.push(`junction ${j.id} crossing [${x}, ${y}] refers to an unknown section`);
      else if (!(sx.crosses ?? []).includes(y)) issues.push(`junction ${j.id} crossing [${x}, ${y}] is not declared on the sections`);
    }
  }
  const pointsInJunctions = new Set(def.junctions.flatMap((j) => j.points));
  for (const p of def.points) if (!pointsInJunctions.has(p.id)) issues.push(`point ${p.id} does not belong to any junction`);

  // --- connectivity ------------------------------------------------------------------
  const first = def.sections[0];
  if (first && issues.length === 0) {
    const adj = new Map<string, Set<string>>();
    const join = (a: string, b: string) => {
      if (!adj.has(a)) adj.set(a, new Set());
      if (!adj.has(b)) adj.set(b, new Set());
      adj.get(a)?.add(b);
      adj.get(b)?.add(a);
    };
    for (const l of def.links) join(l.a.section, l.b.section);
    for (const p of def.points) {
      join(p.toe.section, p.normal.section);
      join(p.toe.section, p.reverse.section);
    }
    const seen = new Set<string>([first.id]);
    const queue = [first.id];
    while (queue.length > 0) {
      const cur = queue.pop();
      if (cur === undefined) break;
      for (const n of adj.get(cur) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    for (const s of def.sections) if (!seen.has(s.id)) issues.push(`section ${s.id} is not connected to the rest of the network`);
  }

  return issues;
}

export function buildNetwork(def: NetworkDef): Network {
  const issues = validateNetworkDef(def);
  if (issues.length > 0) throw new NetworkValidationError(issues);

  const attachments = new Map<string, Attachment>();
  for (const l of def.links) {
    attachments.set(endKey(l.a), { kind: 'link', other: l.b });
    attachments.set(endKey(l.b), { kind: 'link', other: l.a });
  }
  for (const p of def.points) {
    attachments.set(endKey(p.toe), { kind: 'point', point: p.id, role: 'toe' });
    attachments.set(endKey(p.normal), { kind: 'point', point: p.id, role: 'normal' });
    attachments.set(endKey(p.reverse), { kind: 'point', point: p.id, role: 'reverse' });
  }
  for (const b of def.boundaries) attachments.set(endKey(b.at), { kind: 'boundary', boundary: b.id });

  const signalByEnd = new Map<string, SignalDef>();
  for (const s of def.signals) signalByEnd.set(endKey(s.at), s);

  const toMap = <T extends { id: string }>(items: readonly T[]): ReadonlyMap<string, T> => new Map(items.map((i) => [i.id, i]));

  return {
    def,
    sections: toMap(def.sections),
    points: toMap(def.points),
    signals: toMap(def.signals),
    platforms: toMap(def.platforms),
    boundaries: toMap(def.boundaries),
    junctions: toMap(def.junctions),
    attachmentAt(e) {
      const a = attachments.get(endKey(e));
      if (!a) throw new Error(`No attachment at ${endKey(e)}`); // unreachable after validation
      return a;
    },
    signalLeaving(e) {
      return signalByEnd.get(endKey(e));
    },
  };
}
