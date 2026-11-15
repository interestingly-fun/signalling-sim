/**
 * Reversal and the ECS siding cycle (Phase 9). Pure functions over the logical network and a train; no UI.
 *
 * REVERSAL. A reversal is physical: the train is standing, wholly inside the bay (or siding), and the driver changes
 * ends. `reverseTrain` then swaps front and rear: the sections the train occupies stay the same, the path is turned
 * round, and the front is now where the rear was. Nothing about occupancy changes at that instant, so nothing can be
 * "reversed into". The train then waits like any other at the signal at its new front; only a set, proven route from
 * that signal lets it move. Its acceleration and braking are unchanged (they come from the same TrainSpec).
 *
 * WHERE. A reversal happens where the topology says it may (`NetworkDef.reversalBays`: a section with a stop signal at one
 * end and a departure signal at the other) or at the buffer stops of a siding. Whether a train fits is computed from the
 * section length and the train's length, never assumed.
 *
 * SIDINGS. Capacity is the section length less the clearance kept at the buffer stops. A siding holds one train; it is
 * occupied for as long as any part of the train is in its section (ordinary track-circuit occupancy).
 */

import { otherEnd, type Network } from '../topology/network';
import { stockProblem } from '../rollingstock';
import { endOf, occupiedSteps } from './geometry';
import type { EcsEventKind, EcsJob, ReversalState, Train, TrainEvent } from './types';

/** Seconds a driver needs to change ends. */
export const REVERSAL_S = 60;
/** The train plans to stop this far short of a stop signal; a bay must hold the train PLUS this margin. */
export const BAY_END_ALLOWANCE_M = 5;
const EPS = 1e-9;

export type Fit = { readonly ok: true } | { readonly ok: false; readonly reason: string };

// ---------------------------------------------------------------------------
// Capacity and fit
// ---------------------------------------------------------------------------

/** Usable length of a siding: the section length less the clearance kept at the buffer stops. */
export function sidingCapacityM(net: Network, sidingId: string): number {
  const sd = net.sidings.get(sidingId);
  const sec = sd ? net.sections.get(sd.section) : undefined;
  return sd && sec ? Math.max(0, sec.lengthM - sd.clearanceM) : 0;
}

/** Does the whole train, with its clearance, fit in the siding? There is no partial stabling. */
export function sidingFit(net: Network, sidingId: string, lengthM: number): Fit {
  const sd = net.sidings.get(sidingId);
  if (!sd) return { ok: false, reason: `Unknown siding ${sidingId}.` };
  const cap = sidingCapacityM(net, sidingId);
  if (lengthM > cap) return { ok: false, reason: `${sd.name} is too short: the train is ${lengthM} m long and the siding holds ${cap} m.` };
  return { ok: true };
}

/** Can a train of this length stand wholly inside the bay with its front held at the stop signal? */
export function bayFit(net: Network, bayId: string, lengthM: number, stopMarginM: number): Fit {
  const bay = net.reversalBays.get(bayId);
  const sec = bay ? net.sections.get(bay.section) : undefined;
  if (!bay || !sec) return { ok: false, reason: `Unknown reversal bay ${bayId}.` };
  const room = sec.lengthM - stopMarginM - BAY_END_ALLOWANCE_M;
  if (lengthM > room) return { ok: false, reason: `${bay.name} is too short: the train is ${lengthM} m long and the bay has ${Math.max(0, Math.floor(room))} m of room.` };
  return { ok: true };
}

/** Is the siding occupied by a train (anything in its section)? */
export const sidingOccupant = (net: Network, occupancy: Readonly<Record<string, string | null>>, sidingId: string): string | null => {
  const sd = net.sidings.get(sidingId);
  return sd ? (occupancy[sd.section] ?? null) : null;
};

/** Is the whole train inside this one section? */
export function whollyIn(train: Train, section: string): boolean {
  const steps = occupiedSteps(train);
  return steps.length > 0 && steps.every((i) => train.path[i]?.section === section);
}

/**
 * A train working an ECS cycle that has stabled (it is preparing to leave, leaving, or has left) may run over siding track whatever class
 * it now works as: the restriction is on ENTERING a siding (Class 5 only), not on leaving one.
 */
export const leavingSiding = (train: Train): boolean => train.ecs !== null && train.ecs.stage !== 'inbound';

// ---------------------------------------------------------------------------
// The reversal itself
// ---------------------------------------------------------------------------

/**
 * Turns a STANDING train round. Only the sections it still occupies are kept; the path is reversed and the end each
 * section is entered through flips. The new front is the old rear (and the new rear the old front), measured on the new
 * path, so the train covers exactly the same ground as before.
 */
export function reverseTrain(net: Network, train: Train): Train {
  if (train.speedMs > 0.02) throw new Error('A train can only be reversed when it is standing');
  const length = train.spec.lengthM;
  const rear = train.frontM - length;
  const last = train.path.length - 1;
  const total = endOf(train, last);
  let first = 0;
  while (first < last && endOf(train, first) <= rear + EPS) first++;
  const kept = train.path.slice(first).reverse();
  const path = kept.map((s) => ({ section: s.section, enterEnd: otherEnd(s.enterEnd) }));
  const ends: number[] = [];
  let acc = 0;
  for (const s of path) {
    acc += net.sections.get(s.section)?.lengthM ?? 0;
    ends.push(acc);
  }
  return { ...train, path, ends, frontM: total - rear, speedMs: 0 };
}

/** A pending bay reversal makes its stop signal a stop for this train even if the signal shows a proceed aspect. */
export function mustStopAt(net: Network, train: Train, signalId: string): boolean {
  const job = train.ecs;
  if (!job || job.reversal !== null || (job.stage !== 'inbound' && job.stage !== 'onward')) return false;
  const bayId = job.bayQueue[0];
  return bayId !== undefined && net.reversalBays.get(bayId)?.stopSignal === signalId;
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

const say = (events: TrainEvent[], what: EcsEventKind, text: string): void => {
  events.push({ kind: 'ecs', what, text });
};

export interface EcsContext {
  readonly net: Network;
  /** Current aspects (to notice the exit signal clearing). */
  readonly aspects: Readonly<Record<string, string>>;
  readonly occupancy: Readonly<Record<string, string | null>>;
  /** Headcodes of the other live trains (a new headcode must be unique). */
  readonly liveHeadcodes: ReadonlySet<string>;
  readonly dt: number;
  /** The limit the train looked ahead to this step, and its speed after the step. */
  readonly limitKind: string;
  readonly limitSubject: string | undefined;
  readonly gapToStopM: number;
  readonly speedMs: number;
  readonly previousSpeedMs: number;
}

const STANDING = 0.02;

/** Names the reversal point for messages. */
function placeName(net: Network, r: ReversalState): string {
  return r.kind === 'siding' ? (net.sidings.get(r.bay)?.name ?? r.bay) : (net.reversalBays.get(r.bay)?.name ?? r.bay);
}

/**
 * Advances the ECS cycle and any reversal by one step. Returns the updated train (reversed, re-labelled or with new
 * timers) and appends the events. A train without an ECS job is returned unchanged.
 */
export function ecsAdvance(c: EcsContext, trainIn: Train, events: TrainEvent[]): Train {
  let train = trainIn;
  let job = train.ecs;
  if (!job) return train;
  const net = c.net;
  const spec = train.spec;
  const standing = c.speedMs < STANDING;
  const set = (patch: Partial<EcsJob>): void => {
    job = { ...(job as EcsJob), ...patch };
    train = { ...train, ecs: job };
  };

  // --- a reversal in progress ----------------------------------------------------
  const rev = job.reversal;
  if (rev) {
    const place = placeName(net, rev);
    if (rev.phase === 'approaching' || rev.phase === 'braking') {
      if (standing && c.gapToStopM <= 1.5) {
        set({ reversal: { ...rev, phase: 'awaiting' } });
        say(events, 'stopped-for-reversal', `${spec.headcode} has stopped at ${place} and is waiting to reverse.`);
      } else if (rev.phase === 'approaching' && c.speedMs < c.previousSpeedMs - 1e-9) {
        set({ reversal: { ...rev, phase: 'braking' } });
      }
      return train;
    }
    if (rev.phase === 'awaiting') {
      // May it begin? Standing, and wholly inside the place it reverses in.
      const section = rev.kind === 'siding' ? net.sidings.get(rev.bay)?.section : net.reversalBays.get(rev.bay)?.section;
      if (!standing || !section || !whollyIn(train, section)) {
        const note = `Reversal at ${place} cannot begin: the train is not wholly inside it.`;
        if (rev.note !== note) {
          set({ reversal: { ...rev, note } });
          say(events, 'blocked', `${spec.headcode}: ${note}`);
        }
        return train;
      }
      set({ reversal: { ...rev, phase: 'reversing', remainingS: REVERSAL_S, note: '' } });
      return train;
    }
    if (rev.phase === 'reversing') {
      const remaining = rev.remainingS - c.dt;
      if (remaining > EPS) {
        set({ reversal: { ...rev, remainingS: remaining } });
        return train;
      }
      train = reverseTrain(net, train);
      const reversals = job.reversals + 1;
      if (rev.kind === 'siding') {
        set({ reversal: { ...rev, phase: 'ready', remainingS: 0 }, reversals, stage: 'ready', bayQueue: job.departureBays });
      } else {
        set({ reversal: { ...rev, phase: 'ready', remainingS: 0 }, reversals, bayQueue: job.bayQueue.slice(1) });
      }
      say(events, 'reversal-complete', `${spec.headcode} has reversed at ${place}: it now faces the other way and is ready for its onward movement.`);
      return train;
    }
    // 'ready': waits for the departure signal (the step clears it when the signal is passed)
    if (job.stage === 'ready' && rev.kind === 'siding') {
      const exit = net.sidings.get(job.siding)?.exitSignal;
      if (exit && (c.aspects[exit] ?? 'red') !== 'red' && job.note !== 'authorised') {
        set({ note: 'authorised' });
        say(events, 'authorised', `${spec.headcode} is authorised to leave ${net.sidings.get(job.siding)?.name ?? job.siding} (signal ${net.signals.get(exit)?.name ?? exit} is clear).`);
      }
    }
    return train;
  }

  // --- stages -------------------------------------------------------------------
  const siding = net.sidings.get(job.siding);
  if (!siding) return train;

  if (job.stage === 'inbound' || job.stage === 'onward') {
    // Start a bay reversal when the train comes up to the stop signal of the next bay.
    // The signaller chooses the route, so the bay the train meets may not be the one planned: whichever bay's stop
    // signal it comes up to is the one it reverses in, provided it still has a bay reversal to make.
    const bayId = job.bayQueue[0];
    const planned = bayId === undefined ? undefined : net.reversalBays.get(bayId);
    let bay = planned;
    if (planned && c.limitKind === 'signal' && c.limitSubject !== planned.stopSignal) {
      for (const b of net.reversalBays.values()) if (b.stopSignal === c.limitSubject) bay = b;
    }
    if (bay && c.limitKind === 'signal' && c.limitSubject === bay.stopSignal && train.started) {
      set({ bayQueue: [bay.id, ...job.bayQueue.slice(1)], reversal: { bay: bay.id, kind: 'bay', phase: standing && c.gapToStopM <= 1.5 ? 'awaiting' : 'approaching', remainingS: 0, note: '' } });
      say(events, 'approaching-reversal', `${spec.headcode} is approaching ${bay.name} to reverse.`);
      return train;
    }
    // Fully stabled: stopped at the buffer stops with the whole train inside the siding.
    if (job.stage === 'inbound' && standing && c.limitKind === 'buffer' && c.gapToStopM <= 1.5 && whollyIn(train, siding.section)) {
      set({ stage: 'stabled', note: '' });
      say(events, 'stabled', `${spec.headcode} is fully stabled in ${siding.name} (${job.stablingS >= 60 ? `${Math.round(job.stablingS / 60)} min` : `${job.stablingS} s`} stabling).`);
    }
    return train;
  }

  if (job.stage === 'stabled') {
    const remaining = Math.max(0, job.stablingRemainingS - c.dt);
    if (remaining > EPS) {
      set({ stablingRemainingS: remaining });
      return train;
    }
    set({ stablingRemainingS: 0, stage: 'preparing' });
    say(events, 'stabling-complete', `${spec.headcode} has finished stabling in ${siding.name}.`);
  }

  if (job.stage === 'preparing') {
    // Departure preparation: the headcode, class and destination change HERE, not while the train was entering.
    const onward = job.onward;
    if (spec.headcode !== onward.headcode) {
      const problem = onward.trainClass !== spec.trainClass && spec.stock ? stockProblem(onward.trainClass, spec.stock) : null;
      let note = '';
      if (c.liveHeadcodes.has(onward.headcode)) note = `Headcode ${onward.headcode} is already in use.`;
      else if (problem) note = problem;
      if (note) {
        if (job.note !== note) {
          set({ note });
          say(events, 'blocked', `${spec.headcode} cannot prepare to depart: ${note}`);
        }
        return train;
      }
      const old = spec.headcode;
      const oldClass = spec.trainClass;
      train = { ...train, spec: { ...spec, headcode: onward.headcode, trainClass: onward.trainClass, destination: onward.destination }, plan: job.departurePlan };
      say(events, 'new-headcode', `${old} is now ${onward.headcode} (the same train: ${spec.stock?.model ?? 'unit'} ${spec.stock?.formation ?? ''}).`.replace(' )', ')'));
      if (oldClass !== onward.trainClass) say(events, 'new-class', `${onward.headcode} now works as Class ${onward.trainClass} (was Class ${oldClass}), destination ${onward.destination}.`);
    }
    // Change ends in the siding.
    if (standing) {
      set({ note: '', reversal: { bay: siding.id, kind: 'siding', phase: 'awaiting', remainingS: 0, note: '' } });
    }
    return train;
  }

  if (job.stage === 'ready' || job.stage === 'leaving') {
    if (job.stage === 'leaving' && !occupiedSteps(train).some((i) => train.path[i]?.section === siding.section)) {
      set({ stage: 'onward', reversal: null, note: '' });
      say(events, 'siding-released', `${siding.name} is released: ${spec.headcode} has cleared it.`);
    }
  }
  return train;
}

/**
 * Called when the front passes a signal: the siding entry signal, or the exit signal (the end of the ECS-specific
 * authority), or the departure signal of a bay.
 */
export function ecsPassedSignal(net: Network, trainIn: Train, signalId: string, events: TrainEvent[]): Train {
  const job = trainIn.ecs;
  if (!job) return trainIn;
  let train = trainIn;
  const siding = net.sidings.get(job.siding);
  const spec = trainIn.spec;
  if (siding && job.stage === 'inbound' && net.signals.get(signalId)?.mainline === true) {
    say(events, 'entering-siding', `${spec.headcode} is entering ${siding.name}.`);
  }
  if (siding && job.stage === 'ready' && signalId === siding.exitSignal) {
    train = { ...train, ecs: { ...job, stage: 'leaving', reversal: null, note: '' } };
    say(events, 'leaving-siding', `${spec.headcode} is leaving ${siding.name} as ${spec.headcode}.`);
    return train;
  }
  const rev = job.reversal;
  if (rev && rev.phase === 'ready' && rev.kind === 'bay' && net.reversalBays.get(rev.bay)?.departSignal === signalId) {
    train = { ...train, ecs: { ...job, reversal: null } };
  }
  return train;
}
