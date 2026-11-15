import { useEffect } from 'react';
import { msToMph } from '../../engine';
import { placeName } from '../sim/shift';
import type { Simulation } from '../sim/simulation';
import { useSlowFrame } from '../sim/useSlowFrame';

/** The exit boundary / destination in words: "Northbridge (N-OUT)". */
export const destinationText = (boundaryId: string): string => `${placeName(boundaryId)} (${boundaryId})`;

/**
 * Compact train inspector (Phase 8.5): a small, fixed overlay in the top-left corner of the diagram area.
 * It shows only the headcode, the destination, the current speed and the operating class of the SELECTED train.
 * It is outside the zoomed drawing, so panning and zooming never move it. The detailed performance inspector
 * stays in the Testing information area.
 */
export function CompactInspector({ sim }: { sim: Simulation }) {
  useSlowFrame(sim, 100);
  const selected = sim.selectedId === null ? null : (sim.trains.find((t) => t.id === sim.selectedId) ?? null);
  const finished = selected?.finished === true;
  // A selected train that has left the area is deselected, so no stale data stays on screen.
  useEffect(() => {
    if (finished) sim.select(null);
  }, [finished, sim]);

  if (!selected || finished) {
    return (
      <div className="compact-inspector empty" data-testid="compact-inspector" aria-label="Selected train">
        <span className="ci-empty">Select a train</span>
      </div>
    );
  }
  const mph = Math.round(msToMph(selected.speedMs));
  return (
    <dl className="compact-inspector" data-testid="compact-inspector" aria-label="Selected train">
      <div className="ci-head">
        <dt>Headcode</dt>
        <dd data-testid="ci-headcode">{selected.spec.headcode}</dd>
      </div>
      <div>
        <dt>Destination</dt>
        <dd data-testid="ci-destination">{destinationText(selected.spec.destination)}</dd>
      </div>
      <div>
        <dt>Speed</dt>
        <dd data-testid="ci-speed">{mph} mph</dd>
      </div>
      <div>
        <dt>Class</dt>
        <dd data-testid="ci-class">Class {selected.spec.trainClass}</dd>
      </div>
    </dl>
  );
}
