/**
 * What speed may a train do here? (Phase 8)
 *
 * The limit of a SECTION comes from the central configuration: the kind of line, whether the section is
 * the diverging leg of a set of points, and any section-specific entry. The speed a TRAIN may do is the
 * most restrictive of the limits of every section it occupies (front to rear, so a long train stays
 * restricted until its rear has cleared) and its own model's top speed.
 *
 * Because a train's path is the route actually set (it follows the points as they lie), the limits come from
 * the route the interlocking has set, never from a section's name.
 *
 * Pure functions of the network, the configuration and a list of segments. No state.
 */

import type { Network } from '../topology/network';
import type { LineKind } from '../topology/types';
import { mphToMs, msToMph } from '../rollingstock/models';
import { SPEED_CONFIG, type SpeedConfig } from './config';

export type SectionLimitKind = 'line' | 'platform' | 'diverging' | 'junction' | 'siding';

export interface SectionLimit {
  readonly limitMs: number;
  readonly kind: SectionLimitKind;
  /** e.g. "Mainline 125 mph". */
  readonly label: string;
}

/** One stretch of the train's path with its limit; distances are metres along the train's path (the same scale as `frontM`). */
export interface LimitSegment {
  readonly section: string;
  readonly startM: number;
  readonly endM: number;
  readonly limitMs: number;
  readonly label: string;
}

const LINE_NAME: Record<LineKind, string> = { UP: 'Mainline', DOWN: 'Mainline', BRANCH: 'Branch', PLATFORM: 'Platform loop', CROSSOVER: 'Crossover', LINK: 'Link' };

const mph = (ms: number): number => Math.round(msToMph(ms));
const label = (name: string, ms: number): string => `${name} ${mph(ms)} mph`;

const tables = new WeakMap<Network, WeakMap<SpeedConfig, Map<string, SectionLimit>>>();

function build(net: Network, config: SpeedConfig): Map<string, SectionLimit> {
  const out = new Map<string, SectionLimit>();
  const reverseLegs = new Set<string>();
  for (const p of net.points.values()) reverseLegs.add(p.reverse.section);
  for (const s of net.sections.values()) {
    let limit: SectionLimit = {
      limitMs: mphToMs(config.lineMph[s.line]),
      kind: s.line === 'PLATFORM' ? 'platform' : 'line',
      label: label(LINE_NAME[s.line], mphToMs(config.lineMph[s.line])),
    };
    const consider = (ms: number, kind: SectionLimitKind, name: string): void => {
      if (ms < limit.limitMs - 1e-9) limit = { limitMs: ms, kind, label: label(name, ms) };
    };
    if (reverseLegs.has(s.id)) consider(mphToMs(config.divergingMph), 'diverging', 'Diverging route');
    const own = config.sectionMph[s.id];
    if (own !== undefined) consider(mphToMs(own), 'junction', 'Junction leg');
    if (config.sidingSections.includes(s.id)) consider(mphToMs(config.sidingMph), 'siding', 'Siding');
    out.set(s.id, limit);
  }
  return out;
}

/** The limit of one section under a configuration (the central one by default). */
export function sectionLimit(net: Network, sectionId: string, config: SpeedConfig = SPEED_CONFIG): SectionLimit {
  let byConfig = tables.get(net);
  if (!byConfig) tables.set(net, (byConfig = new WeakMap()));
  let table = byConfig.get(config);
  if (!table) byConfig.set(config, (table = build(net, config)));
  const l = table.get(sectionId);
  if (!l) throw new Error(`No speed limit for unknown section ${sectionId}`);
  return l;
}

/**
 * The fastest the train may be going at front position `x`, looking ahead: its own top speed, the limit of
 * every restricted stretch it is inside (until its rear has left it), and for every restriction still ahead
 * the speed from which it can slow to the limit by the start of it at the planned braking rate `aPlan`
 * (v² = u² + 2as). Smooth by construction: it falls along the braking curve, so following it never needs a
 * hard brake at a section boundary.
 */
export function speedEnvelope(segments: readonly LimitSegment[], x: number, lengthM: number, aPlan: number, maxMs: number): number {
  let v = maxMs;
  for (const s of segments) {
    if (s.limitMs >= v) continue;
    if (x < s.startM) v = Math.min(v, Math.sqrt(s.limitMs * s.limitMs + 2 * aPlan * (s.startM - x)));
    else if (x <= s.endM + lengthM) v = s.limitMs;
  }
  return v;
}

export interface Permitted {
  readonly ms: number;
  /** What sets it: "Mainline 125 mph", "Diverging route 40 mph", or "Model maximum 75 mph". */
  readonly label: string;
}

/** The speed permitted right now at front position `x`: the most restrictive of the model maximum and the stretches the train is inside. */
export function permittedAt(segments: readonly LimitSegment[], x: number, lengthM: number, maxMs: number): Permitted {
  let best: Permitted = { ms: maxMs, label: label('Model maximum', maxMs) };
  for (const s of segments) {
    if (x >= s.startM && x <= s.endM + lengthM && s.limitMs < best.ms - 1e-9) best = { ms: s.limitMs, label: s.label };
  }
  return best;
}

export interface NextRestriction {
  readonly section: string;
  readonly limitMs: number;
  readonly label: string;
  /** From the front of the train to the start of the restricted section. */
  readonly distanceM: number;
  /** Distance needed to slow from the present speed to the limit at the service rate (0 when already at or below it). */
  readonly brakingM: number;
}

/** The nearest restriction ahead that is lower than what is permitted now. */
export function nextRestriction(segments: readonly LimitSegment[], x: number, speedMs: number, serviceBrakeMs2: number, permittedMs: number): NextRestriction | null {
  let best: LimitSegment | null = null;
  for (const s of segments) {
    if (s.startM > x && s.limitMs < permittedMs - 1e-9 && (best === null || s.startM < best.startM)) best = s;
  }
  if (!best) return null;
  const braking = speedMs > best.limitMs ? (speedMs * speedMs - best.limitMs * best.limitMs) / (2 * serviceBrakeMs2) : 0;
  return { section: best.section, limitMs: best.limitMs, label: best.label, distanceM: best.startM - x, brakingM: braking };
}
