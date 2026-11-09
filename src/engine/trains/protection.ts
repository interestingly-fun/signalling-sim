/**
 * Interlocking protection that needs to know where trains are.
 *
 * The Phase 2 interlocking is unchanged; this adds one rule on top of it.
 *
 * APPROACH LOCKING. A route cannot be cancelled while a train is in the section
 * its entrance signal stands in, heading for that signal. Otherwise the signal
 * would go to Red under a train that can no longer stop short of it.
 */

import type { SignallingContext } from '../signalling/context';
import { validateCancel } from '../signalling/release';
import { routeLabel } from '../signalling/routeSetting';
import type { Rejection, SignallingState } from '../signalling/types';
import { frontSection, trainDirection } from './geometry';
import type { Train } from './types';

export function validateCancelWithTrains(ctx: SignallingContext, state: SignallingState, trains: readonly Train[], routeId: string): Rejection | null {
  const base = validateCancel(ctx, state, routeId);
  if (base) return base;
  const route = ctx.route(routeId);
  if (!route) return null;
  const entrance = ctx.info(routeId).entrance;
  for (const t of trains) {
    if (t.finished) continue;
    if (frontSection(t) === entrance.section && trainDirection(t) === entrance.dir && t.exited === null) {
      return {
        code: 'CANCEL_OCCUPIED',
        subject: entrance.section,
        message: `Route ${routeLabel(route)} cannot be cancelled: train ${t.spec.headcode} is approaching signal ${route.from} (approach locked).`,
      };
    }
  }
  return null;
}
