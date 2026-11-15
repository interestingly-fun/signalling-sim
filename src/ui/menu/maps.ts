/**
 * Structured data for the main menu's maps (Preliminary Step before Phase 11).
 *
 * This is presentation data only: names, difficulty labels, descriptions and information bullets for the
 * map-selection and information screens. It contains no infrastructure and no simulation logic. A map becomes
 * playable by registering a workstation component for its id in the shell (see Shell.tsx) — nothing here needs to change.
 */

export type MapId = 'clumberfield' | 'ashcombe' | 'northbridge';
export type DifficultyKey = 'easy' | 'medium' | 'intermediate';

export interface DifficultyDef {
  readonly label: string;
  /** CSS colour used for the difficulty label on the selection and information screens. */
  readonly colour: string;
}

export const DIFFICULTIES: Readonly<Record<DifficultyKey, DifficultyDef>> = {
  easy: { label: 'Easy', colour: '#7ed321' },
  medium: { label: 'Medium', colour: '#e6c619' },
  intermediate: { label: 'Intermediate', colour: '#e8782a' },
};

/** A plain line in a conceptual schematic (drawing units are local to the preview). */
export interface SchematicLine {
  readonly points: readonly (readonly [number, number])[];
  readonly role?: 'main' | 'yard' | 'storage' | 'platform' | 'through';
}
export interface SchematicLabel {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly anchor?: 'start' | 'middle' | 'end';
}
export interface Schematic {
  readonly width: number;
  readonly height: number;
  readonly lines: readonly SchematicLine[];
  readonly labels: readonly SchematicLabel[];
}

export type PreviewDef =
  /** The real Ashcombe layout geometry, drawn static (no signals, trains or state). */
  | { readonly kind: 'ashcombe-layout'; readonly caption: string }
  /** The real Northbridge layout geometry, drawn static. */
  | { readonly kind: 'northbridge-layout'; readonly caption: string }
  /** A conceptual sketch of the described features only. The map is not implemented. */
  | { readonly kind: 'conceptual'; readonly caption: string; readonly schematic: Schematic };

export interface MapDef {
  readonly id: MapId;
  readonly name: string;
  readonly difficulty: DifficultyKey;
  readonly summary: string;
  readonly description: string;
  readonly features: readonly string[];
  /** true when the map has no playable implementation yet ("coming soon"). */
  readonly planned: boolean;
  readonly preview: PreviewDef;
}

const clumberfieldSchematic: Schematic = {
  width: 600,
  height: 260,
  lines: [
    { points: [[20, 40], [580, 40]], role: 'main' },
    { points: [[20, 58], [580, 58]], role: 'main' },
    // five parallel yard tracks: four outer storage tracks around a central through track
    { points: [[60, 110], [440, 110]], role: 'storage' },
    { points: [[60, 134], [440, 134]], role: 'storage' },
    { points: [[60, 158], [440, 158]], role: 'through' },
    { points: [[60, 182], [440, 182]], role: 'storage' },
    { points: [[60, 206], [440, 206]], role: 'storage' },
  ],
  labels: [
    { text: 'Clumberfield – Westford mainline', x: 20, y: 28, anchor: 'start' },
    { text: 'Five parallel yard tracks', x: 580, y: 242, anchor: 'end' },
    { text: 'Central through track', x: 456, y: 162, anchor: 'start' },
  ],
};

export const MAPS: readonly MapDef[] = [
  {
    id: 'clumberfield',
    name: 'Clumberfield Freight Yard',
    difficulty: 'medium',
    summary: 'Freight shunting on a five-track yard.',
    description:
      'A freight yard on a double-track mainline between Clumberfield and Westford, built around freight shunting with locomotive movements through the centre of the yard.',
    features: [
      'Double-track mainline between Clumberfield and Westford',
      'Five parallel yard tracks',
      'Four outer tracks for freight wagon storage',
      'Central through track for locomotive movements',
      'Freight shunting operations',
      'Mixed freight, passenger and ECS traffic',
    ],
    planned: true,
    preview: {
      kind: 'conceptual',
      caption: 'Conceptual preview — not a playable map',
      schematic: clumberfieldSchematic,
    },
  },
  {
    id: 'ashcombe',
    name: 'Ashcombe Junction',
    difficulty: 'easy',
    summary: 'Junction with two platform loops and ECS sidings.',
    description:
      'A junction on a double-track mainline with two platform loops, a single-track branch towards Merefield and two ECS sidings, with passenger and ECS operations in both directions.',
    features: [
      'Double-track mainline',
      'UP and DOWN directions',
      'Two platform loops',
      'Single-track branch towards Merefield',
      'Two ECS sidings',
      'Passenger and ECS operations',
    ],
    planned: false,
    preview: { kind: 'ashcombe-layout', caption: 'Track layout (static preview — no signals or trains)' },
  },
  {
    id: 'northbridge',
    name: 'Northbridge Station',
    difficulty: 'intermediate',
    summary: 'Six-platform terminus with a four-track approach.',
    description:
      'A larger terminating station where platform allocation and route management are more complex, with separate AJ and BR railway corridors and a four-track approach from Barchester.',
    features: [
      'Six terminating platforms',
      'Separate AJ and BR railway corridors',
      'Northbridge-West station',
      'Four-track Barchester approach with fast and slow lines',
      'More complex platform allocation and route management',
      'Terminating trains that change ends and depart again',
    ],
    planned: false,
    preview: { kind: 'northbridge-layout', caption: 'Track layout (static preview — no signals or trains)' },
  },
];

export function findMap(id: string): MapDef | undefined {
  return MAPS.find((m) => m.id === id);
}
