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
import { leavingSiding, mustStopAt } from './ecs';
import { NO_SHUNT_AUTHORITY, signalFor, stopsAt } from './shunting';
import { PLATFORM_END_MARGIN_M, platformFit } from './platforms';
import { isTerminalPlatform } from './terminal';
import { sectionLimit, type LimitSegment } from '../speed';
import type { Limit, Train } from './types';

const HORIZON_SECTIONS = 80;
/** A train stops this far short of the buffer stops (Phase 9). */
export const BUFFER_MARGIN_M = 3;
const signalIndex = new WeakMap<Network, Map<string, SignalDef>>();

/** The signal standing at a section end, if any. A main-line shunting signal (AJ1/AJ4) is not one a train must obey: it is ignored here. */
export function signalAtEnd(net: Network, e: SectionEnd): SignalDef | undefined {
  let index = signalIndex.get(net);
  if (!index) {
    index = new Map();
    for (const s of net.signals.values()) if (!s.mainline) index.set(`${s.at.section}.${s.at.end}`, s);
    signalIndex.set(net, index);
  }
  return index.get(`${e.section}.${e.end}`);
}

/** Is the train still due to stop at a platform (not yet finished dwelling)? */
const wantsPlatform = (train: Train): boolean => train.stop !== null && (train.stop.phase === 'pending' || train.stop.phase === 'dwelling');

/**
 * The platform a train would stop at in this section, or undefined. A train still on its way to its station stop
 * stops at the first platform it reaches that it may use (Phase 8.5): the timetable's platform is the PLAN, the route
 * the signaller sets decides the platform actually used. A platform the train does not fit is not used (it runs
 * through; the signaller is refused when trying to set it, see `validateRouteForTrains`).
 */
function stopPlatformIn(net: Network, train: Train, sectionId: string): string | undefined {
  const st = train.stop;
  if (!st) return undefined;
  if (st.phase !== 'pending') return sectionId === st.section ? st.platform : undefined;
  const platformId = net.sections.get(sectionId)?.platform;
  if (!platformId) return undefined;
  // A terminating service stops only at a terminus platform for its terminal stop (and a Northbridge-West platform only for a call).
  if (train.terminal && isTerminalPlatform(net, platformId) !== isTerminalPlatform(net, st.scheduledPlatform)) return undefined;
  return platformFit(net, platformId, train.spec.lengthM).ok ? platformId : undefined;
}

export function lookAhead(net: Network, sig: SignallingState, aspects: Readonly<Record<string, Aspect>>, train: Train, authority: ReadonlySet<string> = NO_SHUNT_AUTHORITY): Limit {
  if (train.exited !== null) return { kind: 'exit', limitM: Infinity, subject: train.exited };

  const last = lastStep(train);
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
  const inPlatform = stopWanted ? stopPlatformIn(net, train, last.section) : undefined;
  if (inPlatform) return done({ kind: 'platform', limitM: m, subject: inPlatform, marginM: PLATFORM_END_MARGIN_M });
  let leaving: SectionEnd = { section: last.section, end: otherEnd(last.enterEnd) };

  for (let i = 0; i < HORIZON_SECTIONS; i++) {
    // The signal that applies to THIS train: a main-line shunting signal applies only to a shunting movement, and a main signal at
    // Danger is passed only under the shunting authority of its associated shunting signal.
    const signal = signalFor(net, train, leaving);
    if (signal && (stopsAt(aspects, authority, train, signal) || mustStopAt(net, train, signal.id))) return done({ kind: 'signal', limitM: m, subject: signal.id });

    const next = nextWithPositions(net, leaving, sig.network.pointPositions);
    if (!next) return done({ kind: 'points', limitM: m, subject: `${leaving.section}.${leaving.end}` });
    if (next.kind === 'exit') return done({ kind: 'exit', limitM: Infinity, subject: next.boundary });
    if (next.kind === 'buffer') return done({ kind: 'buffer', limitM: m, subject: next.boundary, marginM: BUFFER_MARGIN_M });

    const occupant = sig.network.sectionOccupancy[next.enter.section] ?? null;
    if (occupant !== null && occupant !== train.id) return done({ kind: 'occupied', limitM: m, subject: next.enter.section });

    const section = net.sections.get(next.enter.section);
    if (!section) return done({ kind: 'points', limitM: m, subject: next.enter.section });
    // Class restriction: a section the class may not use is a barrier, exactly like a Red signal.
    if (!(section.line === 'SIDING' && leavingSiding(train)) && !classAllowsLine(train.spec.trainClass, section.line, train.spec.stock?.model)) return done({ kind: 'restricted', limitM: m, subject: section.id });
    const lim = sectionLimit(net, section.id);
    segments.push({ section: section.id, startM: m, endM: m + section.lengthM, limitMs: lim.limitMs, label: lim.label });
    m += section.lengthM;
    const reached = stopWanted ? stopPlatformIn(net, train, section.id) : undefined;
    if (reached) return done({ kind: 'platform', limitM: m, subject: reached, marginM: PLATFORM_END_MARGIN_M });
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
    const signal = signalFor(net, train, leaving);
    if (signal) return { signal: signal.id, aspect: aspects[signal.id] ?? 'red', distanceM: Math.max(0, m - train.frontM) };
    const next = nextWithPositions(net, leaving, sig.network.pointPositions);
    if (!next || next.kind === 'exit' || next.kind === 'buffer') return null;
    const section = net.sections.get(next.enter.section);
    if (!section) return null;
    m += section.lengthM;
    leaving = { section: next.enter.section, end: otherEnd(next.enter.end) };
  }
  return null;
}
