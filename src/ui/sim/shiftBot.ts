/**
 * TEST HELPER ONLY. A stand-in signaller that sets each timetabled train's manual routes, looking ahead,
 * through the real interlocking (requestRoute), so whole shifts can be run headlessly. It is not
 * part of the application.
 */
import { requestRoute } from '../../engine';
import type { Train } from '../../engine';
import type { Simulation } from './simulation';
import type { ShiftController } from './shift';

export interface BotOptions {
  /** Never set this movement (to test a signaller who leaves a route unset). */
  readonly skip?: (movement: string, headcode: string) => boolean;
  /** Only start setting a service's routes once the shift clock reaches this time. */
  readonly holdUntil?: (headcode: string, nowS: number) => boolean;
}

/** Distance from the start of the train's path to the entrance signal of one of its movements. */
function signalPosition(sim: Simulation, train: Train, movement: string): number {
  const net = sim.ctx.net;
  const first = sim.ctx.route(train.plan[0] ?? '');
  let pos = first ? (net.sections.get(net.signals.get(first.from)?.at.section ?? '')?.lengthM ?? 0) : 0;
  for (const id of train.plan) {
    if (id === movement) return pos;
    for (const sec of sim.ctx.route(id)?.sections ?? []) pos += net.sections.get(sec)?.lengthM ?? 0;
  }
  return Infinity;
}

/** Is this movement at or beyond the platform's far-end signal (the departure route and everything after it)? */
function isAfterPlatform(sim: Simulation, train: Train, movement: string): boolean {
  const platform = train.stop?.section;
  if (!platform) return false;
  const k = train.plan.indexOf(movement);
  const dep = train.plan.findIndex((id) => sim.ctx.net.signals.get(sim.ctx.route(id)?.from ?? '')?.at.section === platform);
  return dep >= 0 && k >= dep;
}

export function attachBot(sim: Simulation, shift: ShiftController, options: BotOptions = {}): void {
  const done = new Map<string, Set<string>>();
  sim.addStepHook(() => {
    const sh = shift.current;
    if (!sh || sh.status !== 'running') return;
    for (const svc of sh.timetable.services) {
      const a = sh.actuals.get(svc.id);
      if (!a || a.trainId === null || a.exitS !== null || a.cancelledS !== null) continue;
      if (options.holdUntil && options.holdUntil(svc.headcode, sim.clockS)) continue;
      const train = sim.trains.find((t) => t.id === a.trainId);
      if (!train) continue;
      const set = done.get(svc.id) ?? new Set<string>();
      done.set(svc.id, set);
      // A train standing in a platform has its departure route set only as the dwell runs out.
      if (train.stop?.phase === 'dwelling' && train.stop.remainingS > 20) continue;
      for (const m of svc.manual) {
        if (set.has(m)) continue;
        // Like a real signaller, set each route only when the train is near enough to need it: a route set far too early
        // would lock the junction against a train that gets there first.
        // ...and for a train that has still to stop at a platform, the departure route is not set until it is standing there.
        if (train.stop?.phase === 'pending' && isAfterPlatform(sim, train, m)) break;
        const ahead = signalPosition(sim, train, m) - train.frontM;
        if (ahead > Math.max(600, (train.speedMs * train.speedMs) / (2 * train.spec.serviceBrakeMs2) * 1.25 + 250)) break;
        const sig = sim.getSig();
        const r = sim.ctx.route(m);
        if (!r) break;
        if (train.heldRoutes.includes(m)) {
          set.add(m); // this train has already used it
          continue;
        }
        if (sig.residual[m]) continue; // another train is still clearing this route: wait for it, as a signaller would
        if (options.skip?.(m, svc.headcode)) break;
        if (sig.routes[r.from] === m) continue; // set, waiting for the train to pass it
        const res = requestRoute(sim.ctx, sig, r.from, r.to, m);
        if (res.ok) sim.setSig(res.state);
        // Like a real signaller, look ahead: try every remaining route in order, as fast stock needs its routes set early.
      }
    }
  });
}
