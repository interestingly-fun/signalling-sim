/**
 * Operator override of automatic signals: force to Danger, return to automatic.
 *
 * ONLY `signalOverrides` changes. Occupancy, established routes, section and
 * point locks and point positions are left exactly as they are, so forcing a
 * signal can never free anything or move a train. The effective aspect is
 * calculated in aspects.ts from this record, so there is one place that decides
 * what a signal shows and removing the override simply lets the automatic
 * calculation show again.
 */

import type { SignallingContext } from './context';
import type { OverrideResult, SignalOverride, SignallingState } from './types';

export const signalOverride = (state: SignallingState, signalId: string): SignalOverride => state.signalOverrides[signalId] ?? 'AUTOMATIC';

export function setSignalOverride(ctx: SignallingContext, state: SignallingState, signalId: string, override: SignalOverride): OverrideResult {
  const signal = ctx.net.signals.get(signalId);
  if (!signal) return { ok: false, state, rejection: { code: 'NO_SUCH_SIGNAL', subject: signalId, message: `There is no signal ${signalId}.` } };
  if (signal.type !== 'automatic') {
    return { ok: false, state, rejection: { code: 'NOT_AUTOMATIC', subject: signalId, message: `Signal ${signalId} is a manual signal: it is already at Red until a route is set.` } };
  }
  if (signalOverride(state, signalId) === override) {
    // Nothing to change: hand back the identical state, like every other refused or no-op operation.
    return { ok: true, state, message: override === 'FORCED_DANGER' ? `Signal ${signalId} is already forced to Danger.` : `Signal ${signalId} is already automatic.` };
  }
  if (override === 'FORCED_DANGER') {
    return { ok: true, state: { ...state, signalOverrides: { ...state.signalOverrides, [signalId]: 'FORCED_DANGER' } }, message: `Signal ${signalId} forced to Danger (operator override).` };
  }
  const rest = Object.fromEntries(Object.entries(state.signalOverrides).filter(([id]) => id !== signalId));
  return { ok: true, state: { ...state, signalOverrides: rest }, message: `Signal ${signalId} returned to automatic.` };
}

/** IDs of signals currently forced to Danger. */
export const forcedSignals = (state: SignallingState): string[] => Object.keys(state.signalOverrides).sort();
