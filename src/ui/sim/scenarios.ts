/**
 * Predefined scenarios (Phase 6). Each is just a fixed seed for the unchanged timetable generator,
 * chosen because the deterministic timetable it produces has a useful character. The generator and
 * validator are not touched, so every scenario is a fully validated, conflict-free timetable.
 * (A scenario with injected delays would need a new feature in the shift system; it is left for later.)
 */
export interface Scenario {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** null: a fresh random seed each time. */
  readonly seed: number | null;
}

export const SCENARIOS: readonly Scenario[] = [
  { id: 'random', label: 'Random shift', description: 'A new random timetable each time.', seed: null },
  { id: 'normal', label: 'Normal traffic', description: 'A mixture of all three classes: 3 expresses, 2 regional, 1 empty stock; 3 stops.', seed: 1 },
  { id: 'busy', label: 'Busy station', description: 'Seven services, five of them stopping at Ashcombe, with expresses passing.', seed: 77 },
  { id: 'branch', label: 'Branch traffic', description: 'Three services use the Merefield branch.', seed: 57 },
];
