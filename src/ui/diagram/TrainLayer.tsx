/**
 * Draws every train on the existing diagram. Presentation only: positions come
 * from the simulation, shapes from the layout's polylines.
 *
 * Each body is the drawn track between the REAR and the FRONT of the train, so
 * it bends round curves and shows the real length; the white nose marks the
 * front (orientation). The headcode sits in a small tag. Tags are placed so
 * they do not overlap one another: a tag that would collide is lifted to the
 * next free level. The layer is pointer-events: none, so trains never block
 * clicks on signals, points or sections beneath them. Only a thin invisible stroke along the body of
 * each train takes a click (to select it); signals sit beside the track, so they stay clickable.
 */

import { useSyncExternalStore } from 'react';
import type { Network, PathStep } from '../../engine';
import { buildTrackPath, type LayoutDef, type TrackPath } from '../../layout';
import type { Simulation } from '../sim/simulation';

const f1 = (n: number): string => n.toFixed(2);
const toPoints = (pts: readonly (readonly [number, number])[]): string => pts.map((p) => `${f1(p[0])},${f1(p[1])}`).join(' ');

interface Props {
  readonly net: Network;
  readonly layout: LayoutDef;
  readonly sim: Simulation;
  /** Called when the body of a train is clicked. Tags and the rest of the layer never take clicks. */
  readonly onSelectTrain?: (trainId: string) => void;
}

const TAG_H = 15;
const LEVELS = [-17, -33, -49, 18, 34];
const pathCache = new WeakMap<readonly PathStep[], TrackPath>();

interface Placed {
  readonly x: number;
  readonly y: number;
  readonly w: number;
}

const overlaps = (a: Placed, b: Placed): boolean => Math.abs(a.x - b.x) < (a.w + b.w) / 2 + 3 && Math.abs(a.y - b.y) < TAG_H + 2;

export function TrainLayer({ net, layout, sim, onSelectTrain }: Props) {
  useSyncExternalStore(sim.subscribeFrame, sim.getFrame);
  const views = sim.views();
  if (views.length === 0) return null;

  const placed: Placed[] = [];
  const items = views.map((v) => {
    let path = pathCache.get(v.train.path);
    if (!path) {
      path = buildTrackPath(net, layout, v.train.path);
      pathCache.set(v.train.path, path);
    }
    const mid = path.at((v.frontM + v.rearM) / 2).at;
    const label = v.train.spec.headcode;
    const w = 8 + label.length * 7;
    let ty = mid[1] + (LEVELS[0] as number);
    for (const dy of LEVELS) {
      const candidate = { x: mid[0], y: mid[1] + dy, w };
      if (!placed.some((p) => overlaps(p, candidate))) {
        ty = candidate.y;
        break;
      }
    }
    placed.push({ x: mid[0], y: ty, w });
    return { v, path, mid, label, w, ty };
  });

  return (
    <g className="train-layer" pointerEvents="none">
      {items.map(({ v, path, mid, label, w, ty }) => {
        const { train, frontM, rearM } = v;
        const body = path.between(rearM, frontM);
        const nose = path.between(frontM - Math.min(14, train.spec.lengthM / 4), frontM);
        const waiting = train.status === 'waiting to enter';
        return (
          <g
            key={train.id}
            className={`train ${train.state} cls${train.spec.trainClass}${v.selected ? ' selected' : ''}${waiting ? ' waiting' : ''}`}
            aria-label={`Train ${label}`}
            data-headcode={label}
            data-train-id={train.id}
            data-state={train.state}
            data-status={train.status}
            data-selected={v.selected ? 'true' : 'false'}
          >
            {v.selected ? <polyline className="train-halo" points={toPoints(body)} /> : null}
            <polyline className="train-body" points={toPoints(body)} />
            <polyline className="train-nose" points={toPoints(nose)} />
            <polyline
              className="train-hit"
              points={toPoints(body)}
              pointerEvents="stroke"
              onClick={(e) => {
                e.stopPropagation();
                onSelectTrain?.(train.id);
              }}
            >
              <title>{`${label} · Class ${train.spec.trainClass} · ${Math.round(train.speedMs * 2.237)} mph · ${train.status}${train.holdReason ? ' – ' + train.holdReason : ''}`}</title>
            </polyline>
            <g transform={`translate(${f1(mid[0])} ${f1(ty)})`}>
              <rect className="train-tag" x={-w / 2} y={-8} width={w} height={TAG_H} rx={3} />
              <text className="train-tag-text" x={0} y={3.5} textAnchor="middle">
                {label}
              </text>
            </g>
          </g>
        );
      })}
    </g>
  );
}
