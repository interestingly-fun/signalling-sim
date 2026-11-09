/**
 * Visual layout types.
 *
 * The layout is a PURE PRESENTATION layer. It refers to the logical network
 * only by ID and contains nothing the simulation may depend on. Moving a point
 * in here can make the diagram wrong (validateLayout will say so) but can never
 * change which sections connect: that is defined in src/engine/topology.
 */

/** Screen coordinate [x, y]. x grows eastwards (right), y grows southwards (down). */
export type Pt = readonly [number, number];

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Extra drawing space left of x = 0 and right of x = width (approach sections outside the original frame). */
  readonly marginLeft?: number;
  readonly marginRight?: number;
}

export type LabelSize = 'xl' | 'lg' | 'md' | 'sm';

export interface TextLabel {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly anchor?: 'start' | 'middle' | 'end';
  readonly size?: LabelSize;
}

export interface LayoutDef {
  readonly width: number;
  readonly height: number;
  /** Extra drawing space left of x = 0 and right of x = width (approach sections outside the original frame). */
  readonly marginLeft?: number;
  readonly marginRight?: number;
  /**
   * One polyline per section, listed from section end A to section end B.
   * The first vertex is end A, the last vertex is end B.
   */
  readonly sections: Readonly<Record<string, readonly Pt[]>>;
  /** Platform edge drawn alongside the platform track, by platform ID. */
  readonly platforms: Readonly<Record<string, Rect>>;
  /** Optional manual offsets [dx, dy] of section name labels from the section midpoint. */
  readonly sectionLabelOffsets: Readonly<Record<string, readonly [number, number]>>;
  /** Offsets [dx, dy] of point name labels from the point's junction vertex. */
  readonly pointLabelOffsets: Readonly<Record<string, readonly [number, number]>>;
  readonly labels: readonly TextLabel[];
}
