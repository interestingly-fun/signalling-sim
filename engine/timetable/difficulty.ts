/**
 * Shift difficulty (Phase 10).
 *
 * A difficulty is DATA: a profile of numbers the generator reads. Nothing in the generator names a level, so the
 * ranges and the generation parameters can be retuned here without touching the generator.
 *
 * Difficulty changes two things together: how many trains are timetabled (`countRange`, a target, not a promise) and
 * how deliberately they are made to overlap (`overlapBias`, `interactionWeight`, `spanPerServiceS`, `minMaxConcurrent`).
 * The number of trains alone is never the difficulty.
 */

export type DifficultyId = 'beginner' | 'standard' | 'advanced' | 'expert';

export interface DifficultyProfile {
  readonly id: DifficultyId;
  readonly label: string;
  readonly description: string;
  /** Target number of services (inclusive). The generator reduces it, and says why, when the railway cannot support it. */
  readonly countRange: readonly [number, number];
  /** Share of the services that are express (Class 1), regional (Class 2) and empty stock (Class 5): [c1, c5]; Class 2 is the rest. */
  readonly classShare: { readonly c1: number; readonly c5: number };
  /** Most ECS siding cycles in a shift, as a share of the services (rounded, at least 0) and an absolute cap. */
  readonly ecsShare: number;
  readonly ecsMax: number;
  /** Chance that a new service is placed to overlap services already placed (rather than simply after them). */
  readonly overlapBias: number;
  /** How strongly useful interactions (opposing, express/local, branch/main, ECS/passenger, junction) are preferred over plain overlap. */
  readonly interactionWeight: number;
  /** Extra seconds of clearance, beyond the validator's minimum, the generator keeps between conflicting movements. */
  readonly marginS: number;
  /** Target average time between services entering, seconds: the shift's length is about count × this. */
  readonly spanPerServiceS: number;
  /** The shift is regenerated (a few times) until at least this many services are in the area together. */
  readonly minMaxConcurrent: number;
  /** Chance that a Class 2 service is asked to call at a platform. */
  readonly stopBias: number;
}

export const DIFFICULTIES: Readonly<Record<DifficultyId, DifficultyProfile>> = {
  beginner: {
    id: 'beginner',
    label: 'Beginner',
    description: 'Generous margins, mostly independent routes, a few simple simultaneous movements.',
    countRange: [5, 7],
    classShare: { c1: 0.28, c5: 0.2 },
    ecsShare: 0.2,
    ecsMax: 2,
    overlapBias: 0.35,
    interactionWeight: 0.5,
    marginS: 30,
    spanPerServiceS: 280,
    minMaxConcurrent: 2,
    stopBias: 0.8,
  },
  standard: {
    id: 'standard',
    label: 'Standard',
    description: 'Regular simultaneous movements, UP, DOWN and branch services interacting, some ECS.',
    countRange: [8, 12],
    classShare: { c1: 0.25, c5: 0.2 },
    ecsShare: 0.15,
    ecsMax: 2,
    overlapBias: 0.6,
    interactionWeight: 1,
    marginS: 15,
    spanPerServiceS: 210,
    minMaxConcurrent: 3,
    stopBias: 0.8,
  },
  advanced: {
    id: 'advanced',
    label: 'Advanced',
    description: 'Frequent simultaneous movements, express/local interactions, branch and siding work needing careful sequencing.',
    countRange: [13, 18],
    classShare: { c1: 0.25, c5: 0.2 },
    ecsShare: 0.15,
    ecsMax: 3,
    overlapBias: 0.8,
    interactionWeight: 1.6,
    marginS: 5,
    spanPerServiceS: 150,
    minMaxConcurrent: 3,
    stopBias: 0.85,
  },
  expert: {
    id: 'expert',
    label: 'Expert',
    description: 'Dense traffic throughout: competing route-setting decisions, complex junction sequences, passenger and ECS interplay.',
    countRange: [19, 25],
    classShare: { c1: 0.25, c5: 0.2 },
    ecsShare: 0.15,
    ecsMax: 4,
    overlapBias: 0.92,
    interactionWeight: 2.2,
    marginS: 0,
    spanPerServiceS: 110,
    minMaxConcurrent: 4,
    stopBias: 0.85,
  },
};

export const DIFFICULTY_IDS: readonly DifficultyId[] = ['beginner', 'standard', 'advanced', 'expert'];
export const DEFAULT_DIFFICULTY: DifficultyId = 'beginner';

export const difficultyProfile = (id: DifficultyId): DifficultyProfile => DIFFICULTIES[id];

/** The largest number of services any difficulty targets. */
export const MAX_TARGET_SERVICES = Math.max(...DIFFICULTY_IDS.map((d) => DIFFICULTIES[d].countRange[1]));
