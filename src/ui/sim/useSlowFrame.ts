import { useEffect, useState } from 'react';
import type { Simulation } from './simulation';

/**
 * Re-renders a component at most every `ms` milliseconds while the simulation runs (and at once when
 * something changes while it is idle). Panels with text and tables do not need 60 frames a second;
 * only the train drawing does, and it subscribes to every frame itself.
 */
export function useSlowFrame(sim: Simulation, ms = 250): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      timer = null;
      last = performance.now();
      setTick((t) => t + 1);
    };
    const off = sim.subscribeFrame(() => {
      if (timer !== null) return;
      const wait = Math.max(0, ms - (performance.now() - last));
      timer = setTimeout(fire, wait);
    });
    return () => {
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, [sim, ms]);
  return tick;
}
