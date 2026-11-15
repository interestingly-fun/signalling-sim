/**
 * The signalling diagram: a pure visual representation of the logical network.
 *
 * Everything drawn here is derived from three inputs:
 *   - the Network (what exists and how it connects),
 *   - the LayoutDef (where it is drawn),
 *   - the SignallingState (point positions, occupancy, route locks) and the
 *     aspects computed from it by the signalling engine.
 * Nothing is drawn that the Network does not contain, and nothing here decides
 * an aspect or a lock: the diagram only shows what the engine says.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { Aspect, DerivedRoute, Network, SectionEnd, SignalDef, SignallingState } from '../../engine';
import { ASPECT_NAMES } from '../../engine';
import { directionIntoSection, endPoint, midpoint, pathFromEnd, truncatePath, type LayoutDef, type Pt } from '../../layout';
import { sameSelection, type Selection } from '../selection';
import { BUTTON_STEP, DEFAULT_VIEW, DRAG_THRESHOLD_PX, clampView, isDefaultView, panBy, zoomAbout, zoomCentre, zoomPercent, type Box, type View } from './viewport';

interface Props {
  readonly label?: string;
  readonly net: Network;
  readonly layout: LayoutDef;
  readonly state: SignallingState;
  /** Aspect of every signal, from computeAspects. */
  readonly aspects: Readonly<Record<string, Aspect>>;
  readonly selection: Selection | null;
  /** Manual signal chosen as the entrance of a route, or null. */
  readonly entrance: string | null;
  /** Signals the entrance can be routed to. */
  readonly destinations: ReadonlySet<string>;
  /** The route being proposed (previewed), if any, and whether the interlocking would refuse it. */
  readonly proposal: DerivedRoute | null;
  readonly proposalBlocked: boolean;
  readonly showSectionLabels: boolean;
  readonly onSelect: (s: Selection | null) => void;
  readonly onSignalClick: (signalId: string) => void;
  /** Phase 9: the buffer stops of a siding are the destination of a route into it (set from AJ1 or AJ4). */
  readonly onBufferClick?: (boundaryId: string) => void;
  /** Drawn above the track and below the signals (the train layer). */
  readonly overlay?: ReactNode;
  /** The pointer is over a signal (or left it): used to preview the route to that exit. */
  readonly onSignalHover?: (signalId: string | null) => void;
  /** Fixed overlays (they do NOT zoom or pan with the drawing): top-left and top-right corners of the diagram area. */
  readonly hudLeft?: ReactNode;
  readonly hudRight?: ReactNode;
}

const pts = (path: readonly Pt[]): string => path.map(([x, y]) => `${x},${y}`).join(' ');
const f1 = (n: number): string => n.toFixed(1);

/** Inactive point legs are drawn with a gap so the set position is visible. */
const GAP_LENGTH = 11;
const TICK = 5;

function Signal({
  layout,
  signal,
  aspect,
  selected,
  isEntrance,
  isDestination,
  forced,
  onClick,
  onHover,
}: {
  layout: LayoutDef;
  signal: SignalDef;
  aspect: Aspect;
  selected: boolean;
  isEntrance: boolean;
  isDestination: boolean;
  /** Automatic signal the operator has forced to Danger. */
  forced: boolean;
  onClick: (signalId: string) => void;
  onHover?: (signalId: string | null) => void;
}) {
  // The signal governs trains leaving the section through `signal.at`, so the
  // direction of travel is OUT of the section, i.e. opposite to "into the section".
  const into = directionIntoSection(layout, signal.at);
  const travel: Pt = [-into[0], -into[1]];
  // Signals stand on the left of the line (left-hand running). In screen
  // coordinates (y down) the left of a direction (dx, dy) is (dy, -dx).
  const left: Pt = [travel[1], -travel[0]];
  const end = endPoint(layout, signal.at);
  const baseX = end[0] - travel[0] * 7;
  const baseY = end[1] - travel[1] * 7;
  const postX = baseX + left[0] * 15;
  const postY = baseY + left[1] * 15;
  const headX = baseX + left[0] * 22;
  const headY = baseY + left[1] * 22;
  const shunting = signal.type === 'shunting';
  const manual = signal.type === 'manual';
  const eastbound = travel[0] >= 0;
  // label sits beyond the head, on the side away from the track
  const nudge = layout.signalLabelOffsets?.[signal.id] ?? [0, 0];
  const labelX = headX + left[0] * 0 + (eastbound ? -2 : 2) + nudge[0];
  const labelY = headY + left[1] * 12 + 3 + nudge[1];
  const title = `${signal.name}${signal.description ? ` (${signal.description})` : ''} – ${shunting ? 'shunting (manual, interlocked)' : manual ? 'manual (route-set)' : 'automatic'} signal at ${signal.at.section}.${signal.at.end} – ${ASPECT_NAMES[aspect]}${forced ? ' – FORCED TO DANGER by the signaller' : ''}`;

  return (
    <g
      className={`signal ${shunting ? 'shunting' : manual ? 'manual' : 'automatic'}${shunting ? (aspect === 'red' ? ' stop' : ' proceed') : ''}${selected ? ' selected' : ''}${isEntrance ? ' entrance' : ''}${isDestination ? ' destination' : ''}${forced ? ' forced' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick(signal.id);
      }}
      data-signal={signal.id}
      data-aspect={aspect}
      data-signal-name={signal.name}
      onMouseEnter={() => onHover?.(signal.id)}
      onMouseLeave={() => onHover?.(null)}
    >
      <title>{title}</title>
      <line className="signal-arm" x1={f1(baseX)} y1={f1(baseY)} x2={f1(postX)} y2={f1(postY)} />
      <line className="signal-post" x1={f1(postX)} y1={f1(postY)} x2={f1(postX + travel[0] * 5)} y2={f1(postY + travel[1] * 5)} />
      {isEntrance || isDestination ? <circle className="signal-target" cx={f1(headX)} cy={f1(headY)} r={12.5} /> : null}
      {forced ? <rect className="signal-override" x={f1(headX - 9.5)} y={f1(headY - 9.5)} width={19} height={19} rx={2} /> : null}
      {manual ? <circle className="signal-ring" cx={f1(headX)} cy={f1(headY)} r={8.5} /> : null}
      {shunting ? (
        // A shunting signal is a TRIANGLE pointing the way it governs: red (Stop) or green (Proceed). It scales with the drawing.
        // Both indications are always drawn; only the lit one is visible (opacity), so the change can be faded by CSS alone.
        (() => {
          const pts = [
            [headX + travel[0] * 8, headY + travel[1] * 8],
            [headX - travel[0] * 5.5 + left[0] * 6.5, headY - travel[1] * 5.5 + left[1] * 6.5],
            [headX - travel[0] * 5.5 - left[0] * 6.5, headY - travel[1] * 5.5 - left[1] * 6.5],
          ]
            .map(([x, y]) => `${f1(x as number)},${f1(y as number)}`)
            .join(' ');
          return (
            <>
              <polygon className={`shunt-tri stop${aspect === 'red' ? ' lit' : ''}`} points={pts} />
              <polygon className={`shunt-tri proceed${aspect === 'red' ? '' : ' lit'}`} points={pts} />
            </>
          );
        })()
      ) : (
        // Every lamp of the head is always mounted; the CSS fades the lamp that stops being lit out and the one that becomes lit in
        // (Phase 10.5). `lit` is set from the LOGICAL aspect on every render, so the final picture always matches it. Nothing here
        // is read by the simulation.
        <>
          <circle className={`lamp red${aspect === 'red' ? ' lit' : ''}`} cx={f1(headX)} cy={f1(headY)} r={5.2} />
          <circle className={`lamp yellow${aspect === 'yellow' ? ' lit' : ''}`} cx={f1(headX)} cy={f1(headY)} r={5.2} />
          <circle className={`lamp green${aspect === 'green' ? ' lit' : ''}`} cx={f1(headX)} cy={f1(headY)} r={5.2} />
          <circle className={`lamp yellow dy${aspect === 'double-yellow' ? ' lit' : ''}`} cx={f1(headX - travel[0] * 4.2)} cy={f1(headY - travel[1] * 4.2)} r={3.6} />
          <circle className={`lamp yellow dy${aspect === 'double-yellow' ? ' lit' : ''}`} cx={f1(headX + travel[0] * 4.2)} cy={f1(headY + travel[1] * 4.2)} r={3.6} />
        </>
      )}
      <text className="signal-label" x={f1(labelX)} y={f1(labelY)} textAnchor="middle">
        {signal.name}
      </text>
      {forced ? (
        <text className="signal-override-tag" x={f1(labelX)} y={f1(labelY + (left[1] > 0 ? 10 : -22))} textAnchor="middle">
          FD
        </text>
      ) : null}
    </g>
  );
}

export function SignallingDiagram({
  label,
  net,
  layout,
  state,
  aspects,
  selection,
  entrance,
  destinations,
  proposal,
  proposalBlocked,
  showSectionLabels,
  onSelect,
  onSignalClick,
  onBufferClick,
  overlay,
  onSignalHover,
  hudLeft,
  hudRight,
}: Props) {
  const box: Box = useMemo(() => ({ x: -(layout.marginLeft ?? 0), y: -(layout.marginTop ?? 0), w: layout.width + (layout.marginLeft ?? 0) + (layout.marginRight ?? 0), h: layout.height + (layout.marginTop ?? 0) }), [layout]);
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const svgRef = useRef<SVGSVGElement>(null);
  const [panning, setPanning] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ startX: number; startY: number; lastX: number; lastY: number; moved: boolean; pinch: number | null } | null>(null);
  const swallowClick = useRef(false);

  /** Client pixels -> viewport (viewBox) coordinates, and the number of client pixels per viewport unit. */
  const metrics = useCallback((): { rect: DOMRect; scale: number } | null => {
    const el = svgRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return null;
    return { rect, scale: rect.width / box.w };
  }, [box]);
  const toViewport = useCallback(
    (clientX: number, clientY: number): readonly [number, number] | null => {
      const m = metrics();
      return m ? [box.x + (clientX - m.rect.left) / m.scale, box.y + (clientY - m.rect.top) / m.scale] : null;
    },
    [metrics, box],
  );

  // Wheel zoom must not scroll the page, so the listener is not passive. Zoom is centred on the pointer.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = toViewport(e.clientX, e.clientY);
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY;
      const factor = Math.exp(-dy * 0.0016);
      setView((v) => (p ? zoomAbout(v, box, p[0], p[1], factor) : zoomCentre(v, box, factor)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [box, toViewport]);

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    swallowClick.current = false;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) gesture.current = { startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false, pinch: null };
    else if (gesture.current) {
      // a second finger: pinch. Whatever the first finger was doing is no longer a click.
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      gesture.current.moved = true;
      gesture.current.pinch = Math.hypot(a.x - b.x, a.y - b.y);
      swallowClick.current = true;
    }
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (!g || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const m = metrics();
    if (!m) return;
    if (pointers.current.size >= 2 && g.pinch !== null) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = toViewport((a.x + b.x) / 2, (a.y + b.y) / 2);
      if (mid && g.pinch > 0 && d > 0) setView((v) => zoomAbout(v, box, mid[0], mid[1], d / (g.pinch as number)));
      g.pinch = d;
      return;
    }
    if (!g.moved) {
      if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < DRAG_THRESHOLD_PX) return; // still a click
      g.moved = true;
      swallowClick.current = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* pointer capture is optional */
      }
      setPanning(true);
      g.lastX = e.clientX;
      g.lastY = e.clientY;
      return;
    }
    const dx = (e.clientX - g.lastX) / m.scale;
    const dy = (e.clientY - g.lastY) / m.scale;
    g.lastX = e.clientX;
    g.lastY = e.clientY;
    setView((v) => panBy(v, box, dx, dy));
  };
  const endPointer = (e: ReactPointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      gesture.current = null;
      setPanning(false);
    } else if (gesture.current) gesture.current.pinch = null;
  };
  /** A drag must never select or activate whatever was under the pointer when it ended: swallow that click. */
  const onClickCapture = (e: ReactMouseEvent) => {
    if (swallowClick.current) {
      swallowClick.current = false;
      e.stopPropagation();
      e.preventDefault();
    }
  };
  const zoomBy = (factor: number) => setView((v) => zoomCentre(v, box, factor));
  const resetView = () => setView(DEFAULT_VIEW);
  // Keep the view legal if the layout (and so the viewport) ever changes.
  useEffect(() => setView((v) => clampView(v, box)), [box]);

  const routeSections = useMemo(() => new Set(proposal?.sections ?? []), [proposal]);
  const routePoints = useMemo(() => new Map((proposal?.points ?? []).map((r) => [r.point, r.position])), [proposal]);

  const sectionIds = useMemo(() => [...net.sections.keys()], [net]);

  // Short perpendicular ticks mark the insulated joints between sections.
  const ticks = useMemo(() => {
    const out: { key: string; x1: number; y1: number; x2: number; y2: number }[] = [];
    for (const sid of sectionIds) {
      for (const end of ['A', 'B'] as const) {
        const e: SectionEnd = { section: sid, end };
        const att = net.attachmentAt(e);
        if (att.kind === 'point') continue;
        // draw each link joint once (from its lexically first end)
        if (att.kind === 'link' && `${sid}.${end}` > `${att.other.section}.${att.other.end}`) continue;
        const [x, y] = endPoint(layout, e);
        const [dx, dy] = directionIntoSection(layout, e);
        out.push({ key: `${sid}.${end}`, x1: x - dy * TICK, y1: y + dx * TICK, x2: x + dy * TICK, y2: y - dx * TICK });
      }
    }
    return out;
  }, [net, layout, sectionIds]);

  return (
    <div className="diagram-stage" data-testid="diagram-stage">
    <svg
      ref={svgRef}
      className={`diagram${panning ? ' panning' : ''}${isDefaultView(view) ? '' : ' zoomed'}`}
      viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
      role="img"
      aria-label={label ?? 'Signalling diagram'}
      data-zoom={zoomPercent(view)}
      onClick={() => onSelect(null)}
      onClickCapture={onClickCapture}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
    >
      <g className="diagram-content" data-testid="diagram-content" data-k={view.k.toFixed(4)} data-tx={view.tx.toFixed(2)} data-ty={view.ty.toFixed(2)} transform={`translate(${view.tx.toFixed(2)} ${view.ty.toFixed(2)}) scale(${view.k.toFixed(4)})`}>
      {/* Platforms ---------------------------------------------------------- */}
      {[...net.platforms.values()].map((pl) => {
        const r = layout.platforms[pl.id];
        if (!r) return null;
        const occ = state.network.sectionOccupancy[pl.section] ?? null;
        return <rect key={pl.id} className={`platform${occ ? ' occupied' : ''}`} x={r.x} y={r.y} width={r.width} height={r.height} rx={2} />;
      })}

      {/* Track sections ----------------------------------------------------- */}
      {sectionIds.map((sid) => {
        const path = layout.sections[sid];
        if (!path) return null;
        const occupied = (state.network.sectionOccupancy[sid] ?? null) !== null;
        const reservedBy = state.sectionLocks[sid];
        const isSel = sameSelection(selection, { kind: 'section', id: sid });
        const cls = [
          'track',
          reservedBy !== undefined ? 'set' : '',
          routeSections.has(sid) ? (proposalBlocked ? 'route blocked' : 'route') : '',
          occupied ? 'occupied' : '',
          isSel ? 'selected' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <g key={sid} className="section" onClick={(e) => { e.stopPropagation(); onSelect({ kind: 'section', id: sid }); }}>
            <title>{`${sid} – ${net.sections.get(sid)?.line} line, ${net.sections.get(sid)?.lengthM} m${reservedBy !== undefined ? ` – reserved by route ${reservedBy}` : ''}${occupied ? ' – OCCUPIED' : ''}`}</title>
            <polyline className="track-hit" points={pts(path)} />
            <polyline className={cls} points={pts(path)} />
          </g>
        );
      })}

      {/* Inactive point legs: drawn with a gap ------------------------------- */}
      {[...net.points.values()].map((p) => {
        const pos = state.network.pointPositions[p.id] ?? 'normal';
        const inactive = pos === 'normal' ? p.reverse : p.normal;
        const gap = truncatePath(pathFromEnd(layout, inactive), GAP_LENGTH);
        return <polyline key={`gap-${p.id}`} className="point-gap" points={pts(gap)} />;
      })}

      {/* Section joints ------------------------------------------------------- */}
      {ticks.map((t) => (
        <line key={t.key} className="joint" x1={f1(t.x1)} y1={f1(t.y1)} x2={f1(t.x2)} y2={f1(t.y2)} />
      ))}

      {/* Boundaries ----------------------------------------------------------- */}
      {[...net.boundaries.values()].map((b) => {
        const [x, y] = endPoint(layout, b.at);
        const [dx, dy] = directionIntoSection(layout, b.at); // pointing into the area
        const arrow = (sign: 1 | -1, offset: number, key: string) => {
          const ax = x + dx * offset;
          const ay = y + dy * offset;
          const ux = dx * sign;
          const uy = dy * sign;
          const tip: Pt = [ax + ux * 6, ay + uy * 6];
          const l: Pt = [ax - ux * 4 - uy * 5, ay - uy * 4 + ux * 5];
          const r: Pt = [ax - ux * 4 + uy * 5, ay - uy * 4 - ux * 5];
          return <polygon key={key} className="boundary-arrow" points={pts([tip, l, r])} />;
        };
        return (
          <g
            key={b.id}
            className={`boundary${b.buffer ? ' buffer' : ''}${b.buffer && destinations.has(b.id) ? ' destination' : ''}`}
            data-testid={b.buffer ? `buffer-${b.id}` : undefined}
            onClick={b.buffer && onBufferClick ? (e) => { e.stopPropagation(); onBufferClick(b.id); } : undefined}
          >
            <title>{`${b.name}${b.entry ? ' – trains enter here' : ''}${b.exit ? ' – trains leave here' : ''}`}</title>
            {b.buffer ? <rect className="buffer-hit" x={f1(x - 12)} y={f1(y - 14)} width={24} height={28} /> : null}
            <line className="boundary-bar" x1={f1(x - dy * 11)} y1={f1(y + dx * 11)} x2={f1(x + dy * 11)} y2={f1(y - dx * 11)} />
            {b.entry ? arrow(1, 14, 'in') : null}
            {b.exit ? arrow(-1, b.entry ? 28 : 14, 'out') : null}
          </g>
        );
      })}

      {/* Points ---------------------------------------------------------------- */}
      {[...net.points.values()].map((p) => {
        const [x, y] = endPoint(layout, p.toe);
        const pos = state.network.pointPositions[p.id] ?? 'normal';
        const lockedBy = state.pointLocks[p.id];
        const off = layout.pointLabelOffsets[p.id] ?? [0, 20];
        const needed = routePoints.get(p.id);
        const isSel = sameSelection(selection, { kind: 'point', id: p.id });
        return (
          <g
            key={p.id}
            className={`point ${pos}${lockedBy !== undefined ? ' locked' : ''}${isSel ? ' selected' : ''}${needed ? ` needed-${needed}` : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onSelect({ kind: 'point', id: p.id });
            }}
          >
            <title>{`${p.name} – set ${pos}${lockedBy !== undefined ? ` – LOCKED by route ${lockedBy}` : ''}`}</title>
            <circle className="point-hit" cx={x} cy={y} r={11} />
            <circle className="point-dot" cx={x} cy={y} r={3.6} />
            <text className="point-label" x={x + off[0]} y={y + off[1]} textAnchor="middle">
              {p.id} <tspan className={`point-pos ${pos}`}>{pos === 'normal' ? 'N' : 'R'}</tspan>
            </text>
            {lockedBy !== undefined ? (
              <g className="point-lock" transform={`translate(${f1(x + off[0] + 21)} ${f1(y + off[1] - 8)})`}>
                <path d="M-2.4 0 v-2.2 a2.4 2.4 0 0 1 4.8 0 v2.2" />
                <rect x={-3.6} y={0} width={7.2} height={5.4} rx={1} />
              </g>
            ) : null}
          </g>
        );
      })}

      {overlay}

      {/* Signals ----------------------------------------------------------------- */}
      {[...net.signals.values()].map((s) => (
        <Signal
          key={s.id}
          layout={layout}
          signal={s}
          aspect={aspects[s.id] ?? 'red'}
          selected={sameSelection(selection, { kind: 'signal', id: s.id })}
          isEntrance={entrance === s.id}
          isDestination={destinations.has(s.id)}
          forced={state.signalOverrides[s.id] === 'FORCED_DANGER'}
          onClick={onSignalClick}
          onHover={onSignalHover}
        />
      ))}

      {/* Section names -------------------------------------------------------------- */}
      {showSectionLabels
        ? sectionIds.map((sid) => {
            const path = layout.sections[sid];
            if (!path) return null;
            const { at, dir } = midpoint(path);
            const manual = layout.sectionLabelOffsets[sid];
            const horizontal = Math.abs(dir[1]) < 0.3;
            const off: readonly [number, number] = manual ?? (horizontal ? [0, 15] : [-dir[1] * 12, dir[0] * 12]);
            return (
              <text key={`lbl-${sid}`} className="section-label" x={f1(at[0] + off[0])} y={f1(at[1] + off[1])} textAnchor="middle">
                {sid}
              </text>
            );
          })
        : null}

      {/* Location and platform labels ------------------------------------------------ */}
      {layout.labels.map((l, i) => (
        <text key={i} className={`label ${l.size ?? 'md'}`} x={l.x} y={l.y} textAnchor={l.anchor ?? 'start'}>
          {l.text}
        </text>
      ))}
      </g>
    </svg>
    {hudLeft ? <div className="hud hud-left">{hudLeft}</div> : null}
    {hudRight ? <div className="hud hud-right">{hudRight}</div> : null}
    <div className="diagram-nav" role="group" aria-label="Diagram navigation">
      <button type="button" onClick={() => zoomBy(1 / BUTTON_STEP)} aria-label="Zoom out" title="Zoom out" data-testid="zoom-out">
        −
      </button>
      <span className="zoom-level" data-testid="zoom-level" aria-live="polite">
        {zoomPercent(view)}%
      </span>
      <button type="button" onClick={() => zoomBy(BUTTON_STEP)} aria-label="Zoom in" title="Zoom in" data-testid="zoom-in">
        +
      </button>
      <button type="button" onClick={resetView} aria-label="Reset view" title="Reset view" data-testid="zoom-reset" disabled={isDefaultView(view)}>
        Reset view
      </button>
    </div>
    </div>
  );
}
