/**
 * Predefined scenarios (Phase 6). Each is just a fixed seed for the unchanged timetable generator,
 * chosen because the deterministic timetable it produces has a useful character. The generator and
 * validator are not touched, so every scenario is a fully validated, conflict-free timetable.
 * (A scenario with injected delays would need a new feature in the shift system; it is left for later.)
 */
import type { DifficultyId } from '../../engine';

export interface Scenario {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** null: a fresh random seed each time. */
  readonly seed: number | null;
  /** The difficulty the seed was chosen for; null: the difficulty selector decides. */
  readonly difficulty: DifficultyId | null;
}

export const SCENARIOS: readonly Scenario[] = [
  { id: 'random', label: 'Random shift', description: 'A new random timetable each time, at the difficulty selected.', seed: null, difficulty: null },
  { id: 'normal', label: 'Normal traffic', description: 'Beginner: a mixture of all three classes, including an empty-stock trip to the Ashcombe sidings; up to three trains in the area together.', seed: 5, difficulty: 'beginner' },
  { id: 'busy', label: 'Busy station', description: 'Beginner: seven services, most stopping at Ashcombe, with expresses passing and trains overlapping.', seed: 21, difficulty: 'beginner' },
  { id: 'branch', label: 'Branch traffic', description: 'Beginner: three services use the Merefield branch.', seed: 6, difficulty: 'beginner' },
  { id: 'standard', label: 'Standard shift', description: 'Standard: a fixed shift of 8–12 trains with regular overlaps and some empty stock.', seed: 2, difficulty: 'standard' },
  { id: 'advanced', label: 'Advanced shift', description: 'Advanced: a fixed shift of 13–18 trains, with frequent simultaneous movements.', seed: 2, difficulty: 'advanced' },
  { id: 'expert', label: 'Expert shift', description: 'Expert: a fixed shift of 19–25 trains and dense, closely sequenced traffic.', seed: 1, difficulty: 'expert' },
];
