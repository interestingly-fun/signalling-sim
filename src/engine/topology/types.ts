/**
 * Logical railway topology types.
 *
 * Nothing in this file (or anywhere under src/engine) knows about screen
 * coordinates, React or the DOM. The visual diagram lives in src/layout and
 * refers to these objects only by ID.
 *
 * MODEL
 * -----
 * A TRACK SECTION is a track circuit: a stretch of line with two ends, "A" and
 * "B". Every end of every section is attached to exactly one of:
 *   - a LINK      (plain joint to one other section end),
 *   - a POINT     (a switch: toe / normal leg / reverse leg), or
 *   - a BOUNDARY  (edge of the controlled area).
 * Movements are therefore graph traversals: leave a section through one end,
 * look at what that end is attached to, and enter the next section.
 *
 * A DIAMOND CROSSING does not connect anything. Two sections that physically
 * cross are declared in `SectionDef.crosses` so that interlocking treats them
 * as a shared resource.
 */

export type EndId = 'A' | 'B';

/** Reference to one end of one section. */
export interface SectionEnd {
  readonly section: string;
  readonly end: EndId;
}

/**
 * Which way trains may run through a section.
 *  - 'AB'  : only from end A to end B
 *  - 'BA'  : only from end B to end A
 *  - 'both': either way (bi-directionally signalled)
 */
export type TravelDir = 'AB' | 'BA' | 'both';

export type LineKind = 'UP' | 'DOWN' | 'BRANCH' | 'PLATFORM' | 'CROSSOVER' | 'LINK';

export interface SectionDef {
  readonly id: string;
  readonly name: string;
  readonly line: LineKind;
  /** Approximate length in metres (used later for braking / timing). */
  readonly lengthM: number;
  readonly traffic: TravelDir;
  /** Set when this section is a platform track. */
  readonly platform?: string;
  /** Sections this one physically crosses on the flat (diamond). Must be symmetric. */
  readonly crosses?: readonly string[];
}

/** A plain joint between exactly two section ends. */
export interface LinkDef {
  readonly a: SectionEnd;
  readonly b: SectionEnd;
}

export type PointPosition = 'normal' | 'reverse';

/**
 * A set of points. The TOE is the single end; trains from the toe go to the
 * NORMAL or REVERSE leg depending on the position.
 *
 * Occupancy of the TOE section is what "the points are occupied" means: every
 * point has a toe section that physically contains it (see docs/ARCHITECTURE.md).
 */
export interface PointDef {
  readonly id: string;
  readonly name: string;
  readonly toe: SectionEnd;
  readonly normal: SectionEnd;
  readonly reverse: SectionEnd;
}

/** Named group of points / crossings that form one junction. */
export interface JunctionDef {
  readonly id: string;
  readonly name: string;
  readonly points: readonly string[];
  /** Sections that exist only to join the points of this junction (e.g. crossover). */
  readonly sections?: readonly string[];
  /** Diamond crossings belonging to this junction. */
  readonly crossings?: readonly (readonly [string, string])[];
}

export type SignalType = 'automatic' | 'manual';

/**
 * A colour-light signal standing at one end of a section. It governs trains
 * LEAVING that section through that end.
 */
export interface SignalDef {
  readonly id: string;
  readonly name: string;
  readonly type: SignalType;
  readonly at: SectionEnd;
}

export interface PlatformDef {
  readonly id: string;
  readonly name: string;
  readonly section: string;
}

/** Edge of the controlled area. */
export interface BoundaryDef {
  readonly id: string;
  readonly name: string;
  /** Neighbouring location this boundary leads to. */
  readonly location: string;
  /** The section end that touches the boundary. */
  readonly at: SectionEnd;
  /** Trains may enter the area here. */
  readonly entry: boolean;
  /** Trains may leave the area here. */
  readonly exit: boolean;
}

export interface NetworkDef {
  readonly name: string;
  readonly sections: readonly SectionDef[];
  readonly links: readonly LinkDef[];
  readonly points: readonly PointDef[];
  readonly junctions: readonly JunctionDef[];
  readonly signals: readonly SignalDef[];
  readonly platforms: readonly PlatformDef[];
  readonly boundaries: readonly BoundaryDef[];
}

/** What a section end is attached to. */
export type Attachment =
  | { readonly kind: 'link'; readonly other: SectionEnd }
  | { readonly kind: 'point'; readonly point: string; readonly role: 'toe' | 'normal' | 'reverse' }
  | { readonly kind: 'boundary'; readonly boundary: string };

/** A point must be in this position for a movement to be possible. */
export interface PointRequirement {
  readonly point: string;
  readonly position: PointPosition;
}

/**
 * A derived signal-to-signal (or signal-to-boundary) movement.
 * These are the building blocks that route setting will use in Phase 2.
 */
export interface DerivedRoute {
  readonly id: string;
  /** Entrance signal. */
  readonly from: string;
  /** Destination: a signal ID or a boundary ID. */
  readonly to: string;
  readonly toKind: 'signal' | 'boundary';
  /** Sections the train runs over after passing `from`, in order, up to the section the destination signal stands on. */
  readonly sections: readonly string[];
  /** Required point positions, in order of traversal. */
  readonly points: readonly PointRequirement[];
  /** Human-readable tags that help tell routes apart, e.g. "Platform 2", "Branch", "Crossover". */
  readonly features: readonly string[];
  readonly description: string;
}
