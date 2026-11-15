import { createInitialState, isOccupied, reviewSetOccupied } from '../state/state';
import type { Network } from '../topology/network';
import type { SignallingState } from './types';

export function createSignallingState(net: Network): SignallingState {
  return { network: createInitialState(net), routes: {}, sectionLocks: {}, pointLocks: {}, signalOverrides: {}, residual: {} };
}

export const isSectionOccupied = (state: SignallingState, sectionId: string): boolean => isOccupied(state.network, sectionId);

/**
 * TEST AID. Marks a section occupied or clear with no train behind it.
 * Phase 3 replaces this with real train occupancy. It is deliberately not part
 * of route setting: nothing in the interlocking calls it.
 */
export function setTestOccupancy(state: SignallingState, sectionId: string, occupied: boolean): SignallingState {
  return { ...state, network: reviewSetOccupied(state.network, sectionId, occupied) };
}
