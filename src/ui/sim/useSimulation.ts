import { useEffect, useState } from 'react';
import type { SignallingContext, SignallingState } from '../../engine';
import { Simulation } from './simulation';
import { ShiftController } from './shift';
import { localShiftStore } from './storage';

/**
 * Creates the simulation once and drives it from requestAnimationFrame.
 * The loop only feeds elapsed real time to the fixed-step clock; it decides
 * nothing about movement.
 */
export function useSimulation(ctx: SignallingContext, initial: () => SignallingState): Simulation {
  const [sim] = useState(() => new Simulation(ctx, initial()));
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame); // always schedule the next frame first: one failure must not stop the loop for good
      const elapsed = (now - last) / 1000;
      last = now;
      sim.advance(elapsed);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [sim]);
  return sim;
}

/** The shift controller for a simulation: created once, bound to its clock and trains. */
export function useShift(sim: Simulation): ShiftController {
  const [shift] = useState(() => {
    const c = new ShiftController(sim, localShiftStore());
    c.generate(1); // a timetable to inspect from the start; nothing runs until Start shift
    return c;
  });
  useEffect(() => shift.attach(), [shift]);
  return shift;
}
