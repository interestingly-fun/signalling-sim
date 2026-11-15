/**
 * The signal identification convention of Ashcombe Junction (Phase 8.5), as an audit.
 *
 * It is a fictional local convention inspired by British practice, not a claim about real signalling areas:
 *   - manually controlled signals: "AJ" + two digits   (AJ01, AJ02 ...)
 *   - automatic signals:           "AJ" + three digits (AJ100, AJ101 ...)
 *
 * This is ONLY a check that the names given to the signals follow it. Nothing in the simulation reads a name to decide
 * how a signal behaves: that always comes from `SignalDef.type`.
 */

import type { NetworkDef } from './types';

export const MANUAL_NAME = /^AJ\d{2}$/;
export const AUTOMATIC_NAME = /^AJ\d{3}$/;
/** Shunting signals (Phase 9): AJ + ONE digit (AJ1 ... AJ9), a sequential number. Never AJX1 or AJ01-style. */
export const SHUNTING_NAME = /^AJ[1-9]$/;

const FORM = { manual: MANUAL_NAME, automatic: AUTOMATIC_NAME, shunting: SHUNTING_NAME } as const;
const WORDS = { manual: 'AJ and two digits', automatic: 'AJ and three digits', shunting: 'AJ and one digit (1-9)' } as const;

/** Problems with the signal names: wrong form for the signal's type, duplicates. Empty when the convention is followed. */
export function validateSignalNaming(def: Pick<NetworkDef, 'signals'>): string[] {
  const issues: string[] = [];
  const seen = new Map<string, string>();
  for (const s of def.signals) {
    if (!FORM[s.type].test(s.name)) issues.push(`signal ${s.id} (${s.type}) is named "${s.name}": ${WORDS[s.type]} expected`);
    const prev = seen.get(s.name);
    if (prev !== undefined) issues.push(`signals ${prev} and ${s.id} share the name "${s.name}"`);
    else seen.set(s.name, s.id);
  }
  return issues;
}
