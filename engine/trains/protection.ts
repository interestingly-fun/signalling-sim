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
import { routeLabel, validateRoute } from '../signalling/routeSetting';
import { platformFit } from './platforms';
import { platformAllows, routeCorridors, trainCorridor } from './corridors';
import { sidingFit } from './ecs';
import { shuntingMovement } from './shunting';
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
        message: `Route ${routeLabel(ctx, route)} cannot be cancelled: train ${t.spec.headcode} is approaching signal ${ctx.signalName(route.from)} (approach locked).`,
      };
    }
  }
  return null;
}

/**
 * Setting a route when trains are known (Phase 8.5). The interlocking's own checks come first (occupancy, locks,
 * conflicting routes, points). Then, if the route passes through a platform and a train that is still to make its station
 * stop is waiting at, or held by, the entrance signal, the platform must be one that train fits.
 *
 * The timetable's platform is only the plan: ANY platform reached by a valid, available route may be used, so a route
 * is never refused because the train was planned for another platform. An occupied platform is refused by the
 * interlocking (its section is occupied); a too-short one is refused here.
 */
export function validateRouteForTrains(ctx: SignallingContext, state: SignallingState, trains: readonly Train[], routeId: string): Rejection | null {
  const base = validateRoute(ctx, state, routeId);
  if (base) return base;
  const route = ctx.route(routeId);
  if (!route) return null;
  const waitingAt = (t: Train, signalId: string): boolean => {
    const at = ctx.net.signals.get(signalId)?.at;
    return at !== undefined && ((frontSection(t) === at.section && trainDirection(t) === (at.end === 'B' ? 'AB' : 'BA')) || (t.limit?.kind === 'signal' && t.limit.subject === signalId));
  };
  const live = trains.filter((t) => !t.finished && t.exited === null);
  const shuntSignal = ctx.net.signals.get(route.from);
  // The train this route is for: the one at (or held by) its entrance signal. A shunting route set from the throat signal (AJ1/AJ4)
  // is normally set while the train still waits at the ASSOCIATED main signal, so look there too.
  const train = live.find((t) => waitingAt(t, route.from)) ?? (shuntSignal?.mainline ? live.find((t) => (shuntSignal.associatedMain ?? []).some((m) => waitingAt(t, m))) : undefined);

  // Shunting access (Phase 9 correction): a main signal's route to its associated shunting signal is for a SHUNTING MOVEMENT only,
  // that is, a Class 5 ECS train on its way into the sidings. No other train may be given it.
  if (route.shuntAccess && train && (train.spec.trainClass !== 5 || !shuntingMovement(train))) {
    return {
      code: 'SIDING_RESTRICTED',
      subject: route.to,
      message: `Route ${routeLabel(ctx, route)} refused: it is a shunting access route to the sidings and only a Class 5 ECS movement may use it (train ${train.spec.headcode} is Class ${train.spec.trainClass}${train.ecs ? ' ECS' : ''}).`,
    };
  }

  // Sidings (Phase 9): only Class 5 ECS may ENTER one, and the whole train must fit. A train already stabled in a siding
  // (an ECS cycle past its stabling) is leaving, not entering.
  const sidingSections = route.sections.filter((s) => ctx.net.sections.get(s)?.line === 'SIDING');
  if (train && sidingSections.length > 0 && train.ecs?.stage !== 'preparing' && train.ecs?.stage !== 'ready' && train.ecs?.stage !== 'leaving' && train.ecs?.stage !== 'onward') {
    if (train.spec.trainClass !== 5) {
      return {
        code: 'SIDING_RESTRICTED',
        subject: sidingSections[0],
        message: `Route ${routeLabel(ctx, route)} refused: only Class 5 ECS may enter the sidings (train ${train.spec.headcode} is Class ${train.spec.trainClass}).`,
      };
    }
    for (const sd of ctx.net.sidings.values()) {
      if (route.sections.includes(sd.section)) {
        const fit = sidingFit(ctx.net, sd.id, train.spec.lengthM);
        if (!fit.ok) return { code: 'SIDING_UNSUITABLE', subject: sd.id, message: `Route ${routeLabel(ctx, route)} refused: train ${train.spec.headcode} cannot use this siding. ${fit.reason}` };
      }
    }
  }

  // Corridors and platform access (Northbridge): hard rules. A train stays in the corridor it entered by, and may only use platforms
  // whose access lists that corridor.
  if (train) {
    const mine = trainCorridor(ctx.net, train);
    const used = routeCorridors(ctx.net, route);
    if (mine !== undefined && used.some((c) => c !== mine)) {
      return { code: 'CORRIDOR_RESTRICTED', subject: used.find((c) => c !== mine), message: `Route ${routeLabel(ctx, route)} refused: it runs in the ${used.join('/')} corridor but train ${train.spec.headcode} belongs to the ${mine} corridor.` };
    }
    for (const sec of route.sections) {
      const pid = ctx.net.sections.get(sec)?.platform;
      if (pid && !platformAllows(ctx.net, pid, mine)) {
        return { code: 'PLATFORM_ACCESS', subject: pid, message: `Route ${routeLabel(ctx, route)} refused: ${ctx.net.platforms.get(pid)?.name ?? pid} is not available to ${mine ?? 'this'} corridor trains (train ${train.spec.headcode}).` };
      }
    }
  }

  const platforms = route.sections.map((s) => ctx.net.sections.get(s)?.platform).filter((p): p is string => p !== undefined);
  if (platforms.length === 0) return null;
  if (!train || !train.stop || train.stop.phase !== 'pending') return null;
  for (const p of platforms) {
    const fit = platformFit(ctx.net, p, train.spec.lengthM);
    if (!fit.ok) {
      return { code: 'PLATFORM_UNSUITABLE', subject: p, message: `Route ${routeLabel(ctx, route)} refused: train ${train.spec.headcode} cannot use this platform. ${fit.reason}` };
    }
  }
  return null;
}
