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

  // A train still outside the boundary must not be admitted onto an occupied entry section.
  if (train.frontM < 0 && train.path.length === 1) {
    const occupant = sig.network.sectionOccupancy[last.section] ?? null;
    if (occupant !== null && occupant !== train.id) return { kind: 'occupied', limitM: 0, subject: last.section };
  }

  let m = endOf(train, train.path.length - 1);
  // Already in the platform: stop at its far end.
  if (stopWanted && last.section === platformSection) return { kind: 'platform', limitM: m, subject: train.stop?.platform, marginM: PLATFORM_END_MARGIN_M };
  let leaving: SectionEnd = { section: last.section, end: otherEnd(last.enterEnd) };

  for (let i = 0; i < HORIZON_SECTIONS; i++) {
    const signal = signalAtEnd(net, leaving);
    if (signal && (aspects[signal.id] ?? 'red') === 'red') return { kind: 'signal', limitM: m, subject: signal.id };

    const next = nextWithPositions(net, leaving, sig.network.pointPositions);
    if (!next) return { kind: 'points', limitM: m, subject: `${leaving.section}.${leaving.end}` };
    if (next.kind === 'exit') return { kind: 'exit', limitM: Infinity, subject: next.boundary };

    const occupant = sig.network.sectionOccupancy[next.enter.section] ?? null;
    if (occupant !== null && occupant !== train.id) return { kind: 'occupied', limitM: m, subject: next.enter.section };

    const section = net.sections.get(next.enter.section);
    if (!section) return { kind: 'points', limitM: m, subject: next.enter.section };
    // Class restriction: a section the class may not use is a barrier, exactly like a Red signal.
    if (!classAllowsLine(train.spec.trainClass, section.line)) return { kind: 'restricted', limitM: m, subject: section.id };
    m += section.lengthM;
    if (stopWanted && section.id === platformSection) return { kind: 'platform', limitM: m, subject: train.stop?.platform, marginM: PLATFORM_END_MARGIN_M };
    leaving = { section: next.enter.section, end: otherEnd(next.enter.end) };
  }
  return { kind: 'horizon', limitM: m };
}
