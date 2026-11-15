/**
 * Terminating trains (Northbridge). Pure functions over the logical network and a train; no UI.
 *
 * A terminus platform (`NetworkDef.terminals`) has its end A at the throat, with the departure signal, and its end B at the buffer stops.
 * The train arrives at the platform and stops short of the buffers like any platform stop (see platforms.ts), dwells, and only then:
 *   1. changes ends: STANDING, wholly inside the platform, for REVERSAL_S (`reverseTrain` swaps front and rear: occupancy is unchanged),
 *   2. takes its new identity (headcode, class, destination: the same physical train),
 *   3. waits at the departure signal until the signaller sets the departure route,
 *   4. leaves; the platform is released when the rear has cleared it.
 */

import type { Network } from '../topology/network';
import { stockProblem } from '../rollingstock';
import { occupiedSteps } from './geometry';
import { REVERSAL_S, reverseTrain, whollyIn } from './ecs';
import type { EcsEventKind, StopState, Train, TrainEvent, TerminalJob } from './types';

/** Is this platform one of the network's terminating platforms? */
export const isTerminalPlatform = (net: Network, platformId: string): boolean => (net.def.terminals ?? []).some((t) => t.platform === platformId);
/** The terminal whose platform section this is. */
export const terminalOfSection = (net: Network, sectionId: string) => (net.def.terminals ?? []).find((t) => t.section === sectionId);

const say = (events: TrainEvent[], what: EcsEventKind, text: string): void => {
  events.push({ kind: 'ecs', what, text });
};
const STANDING = 0.02;

/** A train standing at the end of its terminal stop (dwell over) or changing ends must not move: it is held where it is. */
export function terminalHolds(net: Network, train: Train): boolean {
  const j = train.terminal;
  if (!j) return false;
  if (j.stage === 'reversing') return true;
  return j.stage === 'inbound' && train.stop !== null && train.stop.phase === 'done' && terminalOfSection(net, train.stop.section) !== undefined && train.speedMs < STANDING;
}

export interface TerminalContext {
  readonly net: Network;
  readonly liveHeadcodes: ReadonlySet<string>;
  readonly dt: number;
  readonly speedMs: number;
}

const newStop = (net: Network, platform: string, dwellS: number): StopState | null => {
  const p = net.platforms.get(platform);
  return p ? { platform, scheduledPlatform: platform, section: p.section, dwellS, remainingS: dwellS, phase: 'pending' } : null;
};

/** Advances the terminating cycle by one step. A train with no terminal job is returned unchanged. */
export function terminalAdvance(c: TerminalContext, trainIn: Train, events: TrainEvent[]): Train {
  let train = trainIn;
  const job = train.terminal;
  if (!job) return train;
  const net = c.net;
  const spec = train.spec;
  const set = (patch: Partial<TerminalJob>): void => {
    train = { ...train, terminal: { ...(train.terminal as TerminalJob), ...patch } };
  };
  const standing = c.speedMs < STANDING;

  // The stop just finished (the rear has cleared its platform): the next stop in the queue becomes the train's stop.
  if (train.stop?.phase === 'departed' && job.stops.length > 0 && job.stage !== 'reversing') {
    const [next, ...rest] = job.stops;
    const st = next ? newStop(net, next.platform, next.dwellS) : null;
    if (st) train = { ...train, stop: st };
    set({ stops: rest });
    return train;
  }

  if (job.stage === 'inbound') {
    const stop = train.stop;
    const term = stop ? terminalOfSection(net, stop.section) : undefined;
    if (stop && term && stop.phase === 'done' && standing && whollyIn(train, term.section)) {
      set({ stage: 'reversing', remainingS: REVERSAL_S, note: '', at: term.section });
      say(events, 'stopped-for-reversal', `${spec.headcode} has finished its dwell at ${term.name} and is changing ends.`);
    }
    return train;
  }

  if (job.stage === 'reversing') {
    const remaining = job.remainingS - c.dt;
    if (remaining > 1e-9) {
      set({ remainingS: remaining });
      return train;
    }
    const onward = job.onward;
    if (spec.headcode !== onward.headcode) {
      const problem = onward.trainClass !== spec.trainClass && spec.stock ? stockProblem(onward.trainClass, spec.stock) : null;
      const note = c.liveHeadcodes.has(onward.headcode) ? `Headcode ${onward.headcode} is already in use.` : (problem ?? '');
      if (note) {
        if (job.note !== note) {
          set({ note });
          say(events, 'blocked', `${spec.headcode} cannot depart: ${note}`);
        }
        return train;
      }
    }
    const old = spec.headcode;
    const oldClass = spec.trainClass;
    train = reverseTrain(net, train);
    train = { ...train, spec: { ...train.spec, headcode: onward.headcode, trainClass: onward.trainClass, destination: onward.destination }, plan: job.departurePlan };
    set({ stage: 'ready', reversals: job.reversals + 1, remainingS: 0, note: '' });
    say(events, 'reversal-complete', `${old} has changed ends: it now faces the other way and is ready for its departure.`);
    if (old !== onward.headcode) say(events, 'new-headcode', `${old} is now ${onward.headcode} (the same train: ${spec.stock?.model ?? 'unit'} ${spec.stock?.formation ?? ''}).`.replace(' )', ')'));
    if (oldClass !== onward.trainClass) say(events, 'new-class', `${onward.headcode} now works as Class ${onward.trainClass} (was Class ${oldClass}), destination ${onward.destination}.`);
    return train;
  }

  if (job.stage === 'leaving') {
    const term = job.at ? terminalOfSection(net, job.at) : undefined;
    const section = term?.section;
    if (section && !occupiedSteps(train).some((i) => train.path[i]?.section === section)) {
      set({ stage: 'done' });
      say(events, 'siding-released', `${term?.name ?? 'The platform'} is clear: ${spec.headcode} has left it.`);
    }
  }
  return train;
}

/** Called when the front passes a signal: the departure signal starts the leaving stage. */
export function terminalPassedSignal(net: Network, train: Train, signalId: string, events: TrainEvent[]): Train {
  const job = train.terminal;
  if (!job || job.stage !== 'ready') return train;
  const term = (net.def.terminals ?? []).find((t) => t.departSignal === signalId);
  if (!term) return train;
  say(events, 'leaving-siding', `${train.spec.headcode} is leaving ${term.name}.`);
  return { ...train, terminal: { ...job, stage: 'leaving' } };
}
