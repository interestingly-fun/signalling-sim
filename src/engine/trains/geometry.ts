/**
 * Where a train is, in logical terms: which sections its front and rear are in
 * and which sections it occupies. All derived from `frontM` and the length.
 */

import type { PathStep, Train } from './types';

export const rearM = (t: Train): number => t.frontM - t.spec.lengthM;

export const startOf = (t: Train, i: number): number => (i === 0 ? 0 : (t.ends[i - 1] ?? 0));
export const endOf = (t: Train, i: number): number => t.ends[i] ?? 0;
export const lastStep = (t: Train): PathStep => {
  const s = t.path[t.path.length - 1];
  if (!s) throw new Error('Train has an empty path');
  return s;
};

/**
 * Indices of the path steps the train occupies for a given front position:
 * a section is occupied while any part of the train is in it, i.e. the front
 * has reached its start and the rear has not yet passed its end.
 */
export function occupiedSteps(t: Train, frontM: number = t.frontM): number[] {
  const rear = frontM - t.spec.lengthM;
  const out: number[] = [];
  for (let i = 0; i < t.path.length; i++) {
    if (frontM >= startOf(t, i) && rear < endOf(t, i) - 1e-9) out.push(i);
  }
  return out;
}

/** Section the front is in (the last section if the front is past it), or null if it is still outside. */
export function frontSection(t: Train): string | null {
  if (t.frontM < 0) return null;
  for (let i = 0; i < t.path.length; i++) if (t.frontM < endOf(t, i)) return t.path[i]?.section ?? null;
  return t.path[t.path.length - 1]?.section ?? null;
}

/** Section the rear is in, or null when it is outside the area (not yet in, or already out). */
export function rearSection(t: Train): string | null {
  const r = rearM(t);
  if (r < 0 || r >= (t.ends[t.ends.length - 1] ?? 0)) return null;
  for (let i = 0; i < t.path.length; i++) if (r < endOf(t, i)) return t.path[i]?.section ?? null;
  return null;
}

/** Direction of travel through the section the front is in. */
export function trainDirection(t: Train): 'AB' | 'BA' {
  const name = frontSection(t);
  const step = t.path.find((s) => s.section === name) ?? lastStep(t);
  return step.enterEnd === 'A' ? 'AB' : 'BA';
}
