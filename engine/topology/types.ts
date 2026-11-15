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

export type LineKind = 'UP' | 'DOWN' | 'BRANCH' | 'PLATFORM' | 'CROSSOVER' | 'LINK' | 'SIDING';

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
  /**
   * Northbridge: the independent corridor this track belongs to (e.g. 'AJ', 'BR'). Absent = shared (a terminus throat or
   * platform that both corridors may use). A route may never combine two corridors, and a train stays in the corridor it entered by.
   */
  readonly corridor?: string;
  /** Northbridge: 'fast' or 'slow' running line (information for the player; the signaller chooses). */
  readonly speedClass?: 'fast' | 'slow';
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

/**
 * automatic : clears by itself from the state of the track ahead.
 * manual    : a route is set by the signaller.
 * shunting  : (Phase 9) a low-speed signal for shunting and ECS movements. Like a manual signal it never clears by itself
 *             and only shows Proceed for an established, proven route; it is drawn as a triangle pointing the way it governs.
 */
export type SignalType = 'automatic' | 'manual' | 'shunting';

/**
 * A colour-light signal standing at one end of a section. It governs trains
 * LEAVING that section through that end.
 */
export interface SignalDef {
  /** Permanent internal identifier (interlocking, route table, saved data). Never shown as the signal's identity. */
  readonly id: string;
  /** The identity shown to the player (e.g. AJ01 manual, AJ100 automatic). Display only: behaviour comes from `type`. */
  readonly name: string;
  /** Optional plain-language location, e.g. "Platform 1 east starter". */
  readonly description?: string;
  readonly type: SignalType;
  readonly at: SectionEnd;
  /**
   * Phase 9: a shunting signal standing ON a main line where a siding lead leaves it (AJ1, AJ4). Trains running along the main
   * line ignore it whatever it shows (routes pass straight through it); it exists to start the movement into the sidings, and it
   * shows green (not red) when the route into the sidings is set.
   */
  readonly mainline?: boolean;
  /**
   * Phase 9 correction: the ordinary (manual) signals this shunting signal is ASSOCIATED with. Only a signal listed here can have
   * a route to this shunting signal (the shunting access route), and only while that route is set and this signal shows Proceed
   * may a shunting movement pass the main signal at Danger. Authority is never implied: it follows this explicit list.
   */
  readonly associatedMain?: readonly string[];
}

export interface PlatformDef {
  readonly id: string;
  readonly name: string;
  readonly section: string;
  /** Corridors whose trains may use this platform. Absent = any. Enforced by the interlocking, not only the timetable. */
  readonly access?: readonly string[];
}

/** A corridor: an independent route between this area and one neighbouring place. */
export interface CorridorDef {
  readonly id: string;
  readonly name: string;
  readonly location: string;
}

/**
 * A terminating platform (Northbridge): trains arrive, stop short of the buffer stops, dwell, change ends and leave again
 * through the signal at the platform's entrance end. `section` has its end A at the throat and its end B at the buffer stops.
 */
export interface TerminalDef {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly section: string;
  readonly departSignal: string;
  readonly buffer: string;
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
  /** Phase 9: the end of a siding (buffer stops). Nothing enters or leaves here: it is where a train stops. */
  readonly buffer?: boolean;
}

/**
 * Phase 9: a stabling siding. Its capacity is NOT stored: it is the length of `section` less `clearanceM`
 * (kept clear at the buffer stops), so a different length in the topology changes the capacity automatically.
 */
export interface SidingDef {
  readonly id: string;
  readonly name: string;
  /** The siding track section. Its end A is the entrance, its end B the buffer stops. */
  readonly section: string;
  /** The shunting signal that authorises leaving. (Entry is set from the main-line shunting signals AJ1/AJ4: there is no entry signal.) */
  readonly exitSignal: string;
  /** Length kept clear at the buffer stops, metres. */
  readonly clearanceM: number;
}

/**
 * Phase 9: a place a train may stop and reverse. The train stands in `section` with its front at `stopEnd` (held at the
 * signal there), then leaves through the other end, governed by `departSignal`. Only the length of the section decides which trains fit.
 */
export interface ReversalBayDef {
  readonly id: string;
  readonly name: string;
  readonly section: string;
  /** The end the train approaches and stops at (where `stopSignal` stands). */
  readonly stopEnd: EndId;
  readonly stopSignal: string;
  /** The signal that governs leaving in the new direction (at the other end). */
  readonly departSignal: string;
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
  /** Phase 9. Absent in a network with no sidings. */
  readonly sidings?: readonly SidingDef[];
  readonly reversalBays?: readonly ReversalBayDef[];
  /** Northbridge. Absent in a network with a single corridor and no terminus. */
  readonly corridors?: readonly CorridorDef[];
  readonly terminals?: readonly TerminalDef[];
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
  /**
   * Phase 9 correction: a SHUNTING ACCESS route, from an ordinary manual signal to its associated shunting signal. The main signal
   * stays at Danger while it is set: a train may pass it only under the shunting signal's authority (see trains/shunting.ts).
   */
  readonly shuntAccess?: boolean;
}
