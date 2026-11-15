import { northbridgeDefinition } from '../engine';
import { northbridgeLayout } from '../layout';
import { createWorkstation } from './App';

/** Northbridge Station: two independent corridors (AJ, BR) meeting at a six-platform terminus. */
export const NorthbridgeApp = createWorkstation({
  name: 'Northbridge Station',
  diagramLabel: 'Northbridge Station',
  definition: northbridgeDefinition,
  layout: northbridgeLayout,
  storageKey: 'northbridge.shifts',
  manualTrains: false,
  about: (
    <>
      <p>
        <strong>Corridors:</strong> AJ (Ashcombe Junction, two lines) and BR (Barchester, four lines: two fast, two outer slow) are independent. No route joins them and no train changes corridor; they
        meet only at platforms 3 and 4 and the scissors crossing in front of them.
      </p>
      <p>
        <strong>Platforms:</strong> Northbridge-West 1 and 2 are AJ only, 3 and 4 are BR only. At the terminus, platforms 1 and 2 are AJ only, 3 and 4 AJ or BR, 5 and 6 BR only: the interlocking refuses a route that breaks
        this. Fast or slow on the BR lines is the signaller&apos;s choice (westbound at NB13; eastbound by the line the train enters on).
      </p>
      <p>
        <strong>Additions to the reference drawing:</strong> westbound crossovers X1 and X2, westbound connectors from the platform 3/4 diagonals, and departure signals NB31 to NB36, so that terminating trains can leave.
      </p>
    </>
  ),
});
