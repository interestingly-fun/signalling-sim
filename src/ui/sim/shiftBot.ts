/**
 * TEST HELPER ONLY. A stand-in signaller that sets each timetabled train's manual routes in order,
 * through the real interlocking (requestRoute), so whole shifts can be run headlessly. It is not
 * part of the application.
 */
import { requestRoute } from '../../engine';
import type { Simulation } from './simulation';
import type { ShiftController } from './shift';

export interface BotOptions {
  /** Never set this movement (to test a signaller who leaves a route unset). */
  readonly skip?: (movement: string, headcode: string) => boolean;
  /** Only start setting a service's routes once the shift clock reaches this time. */
  readonly holdUntil?: (headcode: string, nowS: number) => boolean;
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
      for (const m of svc.manual) {
        if (set.has(m)) continue;
        const sig = sim.getSig();
        const r = sim.ctx.route(m);
        if (!r) break;
        if (train.heldRoutes.includes(m) || sig.residual[m]) {
          set.add(m);
          continue;
        }
        if (options.skip?.(m, svc.headcode)) break;
        if (sig.routes[r.from] === m) break; // set, waiting for the train to pass it
        const res = requestRoute(sim.ctx, sig, r.from, r.to, m);
        if (res.ok) {
          sim.setSig(res.state);
          // keep going: a route set may let the next one be set too only after this one is passed
        }
        break; // one route at a time per train, in order
      }
    }
  });
}
