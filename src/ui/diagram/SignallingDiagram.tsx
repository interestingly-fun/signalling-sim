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

import { useMemo, type ReactNode } from 'react';
import type { Aspect, DerivedRoute, Network, SectionEnd, SignalDef, SignallingState } from '../../engine';
import { ASPECT_NAMES } from '../../engine';
import { directionIntoSection, endPoint, midpoint, pathFromEnd, truncatePath, type LayoutDef, type Pt } from '../../layout';
import { sameSelection, type Selection } from '../selection';

interface Props {
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
  /** Drawn above the track and below the signals (the train layer). */
  readonly overlay?: ReactNode;
  /** The pointer is over a signal (or left it): used to preview the route to that exit. */
  readonly onSignalHover?: (signalId: string | null) => void;
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
  const manual = signal.type === 'manual';
  const eastbound = travel[0] >= 0;
  // label sits beyond the head, on the side away from the track
  const labelX = headX + left[0] * 0 + (eastbound ? -2 : 2);
  const labelY = headY + left[1] * 12 + 3;
  const title = `${signal.name} – ${manual ? 'manual (route-set)' : 'automatic'} signal at ${signal.at.section}.${signal.at.end} – ${ASPECT_NAMES[aspect]}${forced ? ' – FORCED TO DANGER by the signaller' : ''}`;

  return (
    <g
      className={`signal ${manual ? 'manual' : 'automatic'}${selected ? ' selected' : ''}${isEntrance ? ' entrance' : ''}${isDestination ? ' destination' : ''}${forced ? ' forced' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick(signal.id);
      }}
      onMouseEnter={() => onHover?.(signal.id)}
      onMouseLeave={() => onHover?.(null)}
    >
      <title>{title}</title>
      <line className="signal-arm" x1={f1(baseX)} y1={f1(baseY)} x2={f1(postX)} y2={f1(postY)} />
      <line className="signal-post" x1={f1(postX)} y1={f1(postY)} x2={f1(postX + travel[0] * 5)} y2={f1(postY + travel[1] * 5)} />
      {isEntrance || isDestination ? <circle className="signal-target" cx={f1(headX)} cy={f1(headY)} r={12.5} /> : null}
      {forced ? <rect className="signal-override" x={f1(headX - 9.5)} y={f1(headY - 9.5)} width={19} height={19} rx={2} /> : null}
      {manual ? <circle className="signal-ring" cx={f1(headX)} cy={f1(headY)} r={8.5} /> : null}
      {aspect === 'double-yellow' ? (
        <>
          <circle className="lamp yellow" cx={f1(headX - travel[0] * 4.2)} cy={f1(headY - travel[1] * 4.2)} r={3.6} />
          <circle className="lamp yellow" cx={f1(headX + travel[0] * 4.2)} cy={f1(headY + travel[1] * 4.2)} r={3.6} />
        </>
      ) : (
        <circle className={`lamp ${aspect}`} cx={f1(headX)} cy={f1(headY)} r={5.2} />
      )}
      <text className="signal-label" x={f1(labelX)} y={f1(labelY)} textAnchor="middle">
        {signal.id}
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
  overlay,
  onSignalHover,
}: Props) {
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
    <svg
      className="diagram"
      viewBox={`${-(layout.marginLeft ?? 0)} 0 ${layout.width + (layout.marginLeft ?? 0) + (layout.marginRight ?? 0)} ${layout.height}`}
      role="img"
      aria-label="Ashcombe Junction signalling diagram"
      onClick={() => onSelect(null)}
    >
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
          <g key={b.id} className="boundary">
            <title>{`${b.name}${b.entry ? ' – trains enter here' : ''}${b.exit ? ' – trains leave here' : ''}`}</title>
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
    </svg>
  );
}
