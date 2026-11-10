/**
 * What limits the train ahead? Reads the signalling state; changes nothing.
 *
 * Starting from the end of the last section the train has entered, the scan
 * walks the network the way the train physically would, using the CURRENT point
 * positions, and reports the first thing it must not go past:
 *   - a signal showing Red (aspects come from computeAspects, never decided here),
 *   - a point that is not set for the way ahead (or no way ahead),
 *   - a section occupied by something else.
 * The train may only run on through a signal that shows a proceed aspect.
 */

import { otherEnd, type Network } from '../topology/network';
import { nextWithPositions } from '../topology/traversal';
import type { SectionEnd, SignalDef } from '../topology/types';
import type { Aspect, SignallingState } from '../signalling/types';
import { endOf, lastStep } from './geometry';
import { classAllowsLine } from './classes';
import { PLATFORM_END_MARGIN_M } from './platforms';
import { sectionLimit, type LimitSegment } from '../speed';
import type { Limit, Train } from './types';

const HORIZON_SECTIONS = 80;
const signalIndex = new WeakMap<Network, Map<string, SignalDef>>();

/** The signal standing at a section end, if any. */
export function signalAtEnd(net: Network, e: SectionEnd): SignalDef | undefined {
  let index = signalIndex.get(net);
  if (!index) {
    index = new Map();
    for (const s of net.signals.values()) index.set(`${s.at.section}.${s.at.end}`, s);
    signalIndex.set(net, index);
  }
  return index.get(`${e.section}.${e.end}`);
}

/** Is the train still due to stop at a platform (not yet finished dwelling)? */
const wantsPlatform = (train: Train): boolean => train.stop !== null && (train.stop.phase === 'pending' || train.stop.phase === 'dwelling');

export function lookAhead(net: Network, sig: SignallingState, aspects: Readonly<Record<string, Aspect>>, train: Train): Limit {
  if (train.exited !== null) return { kind: 'exit', limitM: Infinity, subject: train.exited };

  const last = lastStep(train);
  const platformSection = train.stop?.section;
  const stopWanted = wantsPlatform(train);
  /** The speed-limited stretches of the sections walked through (sections the train has not entered yet). */
  const segments: LimitSegment[] = [];
  const done = (limit: Limit): Limit => ({ ...limit, segments });

  // A train still outside the boundary must not be admitted onto an occupied entry section.
  if (train.frontM < 0 && train.path.length === 1) {
    const occupant = sig.network.sectionOccupancy[last.section] ?? null;
    if (occupant !== null && occupant !== train.id) return done({ kind: 'occupied', limitM: 0, subject: last.section });
  }

  let m = endOf(train, train.path.length - 1);
  // Already in the platform: stop at its far end.
  if (stopWanted && last.section === platformSection) return done({ kind: 'platform', limitM: m, subject: train.stop?.platform, marginM: PLATFORM_END_MARGIN_M });
  let leaving: SectionEnd = { section: last.section, end: otherEnd(last.enterEnd) };

  for (let i = 0; i < HORIZON_SECTIONS; i++) {
    const signal = signalAtEnd(net, leaving);
    if (signal && (aspects[signal.id] ?? 'red') === 'red') return done({ kind: 'signal', limitM: m, subject: signal.id });

    const next = nextWithPositions(net, leaving, sig.network.pointPositions);
    if (!next) return done({ kind: 'points', limitM: m, subject: `${leaving.section}.${leaving.end}` });
    if (next.kind === 'exit') return done({ kind: 'exit', limitM: Infinity, subject: next.boundary });

    const occupant = sig.network.sectionOccupancy[next.enter.section] ?? null;
    if (occupant !== null && occupant !== train.id) return done({ kind: 'occupied', limitM: m, subject: next.enter.section });

    const section = net.sections.get(next.enter.section);
    if (!section) return done({ kind: 'points', limitM: m, subject: next.enter.section });
    // Class restriction: a section the class may not use is a barrier, exactly like a Red signal.
    if (!classAllowsLine(train.spec.trainClass, section.line, train.spec.stock?.model)) return done({ kind: 'restricted', limitM: m, subject: section.id });
    const lim = sectionLimit(net, section.id);
    segments.push({ section: section.id, startM: m, endM: m + section.lengthM, limitMs: lim.limitMs, label: lim.label });
    m += section.lengthM;
    if (stopWanted && section.id === platformSection) return done({ kind: 'platform', limitM: m, subject: train.stop?.platform, marginM: PLATFORM_END_MARGIN_M });
    leaving = { section: next.enter.section, end: otherEnd(next.enter.end) };
  }
  return done({ kind: 'horizon', limitM: m });
}

export interface SignalAhead {
  readonly signal: string;
  readonly aspect: Aspect;
  /** Distance from the front of the train to the signal, metres. */
  readonly distanceM: number;
}

/**
 * The next signal the train will meet, whatever its aspect, following the points as they lie now.
 * Information only (the performance inspector); the movement engine uses `lookAhead`.
 * Null when the train is leaving the area and no signal stands between it and the boundary.
 */
export function signalAhead(net: Network, sig: SignallingState, aspects: Readonly<Record<string, Aspect>>, train: Train): SignalAhead | null {
  if (train.exited !== null || train.finished) return null;
  const last = lastStep(train);
  let m = endOf(train, train.path.length - 1);
  let leaving: SectionEnd = { section: last.section, end: otherEnd(last.enterEnd) };
  for (let i = 0; i < HORIZON_SECTIONS; i++) {
    const signal = signalAtEnd(net, leaving);
    if (signal) return { signal: signal.id, aspect: aspects[signal.id] ?? 'red', distanceM: Math.max(0, m - train.frontM) };
    const next = nextWithPositions(net, leaving, sig.network.pointPositions);
    if (!next || next.kind === 'exit') return null;
    const section = net.sections.get(next.enter.section);
    if (!section) return null;
    m += section.lengthM;
    leaving = { section: next.enter.section, end: otherEnd(next.enter.end) };
  }
  return null;
}
