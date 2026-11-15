/**
 * Zoom and pan of the signalling diagram (Phase 8.5). Pure maths, no React or DOM.
 *
 * The whole drawing is one SVG group with the transform `translate(tx ty) scale(k)`, so tracks, signals, trains,
 * labels and hit areas always move together and cannot become misaligned. The geometry itself is never changed.
 *
 * Coordinates: a DIAGRAM point `c` (the layout's own units) appears at VIEWPORT point `s = t + k·c`, where the
 * viewport is the SVG's viewBox. A pointer position is converted into viewport coordinates with the SVG's own
 * screen matrix (done in the component); everything here works in those two spaces only.
 */

export interface View {
  readonly k: number;
  readonly tx: number;
  readonly ty: number;
}

/** The viewport: the SVG viewBox rectangle. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export const MIN_ZOOM = 0.7;
export const MAX_ZOOM = 5;
export const BUTTON_STEP = 1.25;
export const DEFAULT_VIEW: View = { k: 1, tx: 0, ty: 0 };
/** A pointer must move this far (screen pixels) before a press becomes a drag; below it, it is a click. */
export const DRAG_THRESHOLD_PX = 4;

const clamp = (v: number, a: number, b: number): number => Math.min(Math.max(v, Math.min(a, b)), Math.max(a, b));

/**
 * Keeps the drawing in view: when zoomed in, its edges cannot be dragged inside the viewport (no empty space beyond
 * the drawing); when zoomed out, the drawing cannot leave the viewport.
 */
export function clampView(view: View, box: Box): View {
  const k = clamp(view.k, MIN_ZOOM, MAX_ZOOM);
  const bound = (t: number, origin: number, size: number): number => clamp(t, (1 - k) * origin, (1 - k) * (origin + size));
  return { k, tx: bound(view.tx, box.x, box.w), ty: bound(view.ty, box.y, box.h) };
}

/** The diagram point under a viewport point. */
export const toDiagram = (view: View, px: number, py: number): readonly [number, number] => [(px - view.tx) / view.k, (py - view.ty) / view.k];

/** Zooms by `factor`, keeping the diagram point under (px, py) where it is (as far as the limits allow). */
export function zoomAbout(view: View, box: Box, px: number, py: number, factor: number): View {
  const k = clamp(view.k * factor, MIN_ZOOM, MAX_ZOOM);
  const [cx, cy] = toDiagram(view, px, py);
  return clampView({ k, tx: px - cx * k, ty: py - cy * k }, box);
}

/** Zooms about the middle of the viewport (the zoom buttons). */
export const zoomCentre = (view: View, box: Box, factor: number): View => zoomAbout(view, box, box.x + box.w / 2, box.y + box.h / 2, factor);

export const panBy = (view: View, box: Box, dx: number, dy: number): View => clampView({ ...view, tx: view.tx + dx, ty: view.ty + dy }, box);

export const zoomPercent = (view: View): number => Math.round(view.k * 100);

export const isDefaultView = (view: View): boolean => view.k === 1 && view.tx === 0 && view.ty === 0;
