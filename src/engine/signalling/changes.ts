/**
 * What changed between two signalling states, in operator language (Phase 6).
 *
 * A pure function used by the event log. It reads two immutable states and reports route
 * establishment and cancellation, point movement, point locking and unlocking, forced Danger and its
 * removal, and the aspect of MANUAL signals changing between Danger and a proceed aspect.
 * It decides nothing and changes nothing. Automatic signals change aspect constantly as trains move,
 * so only forcing them to Danger is reported.
 *
 * A route that disappears because a train passed its entrance signal (it becomes `residual`) is not a
 * cancellation, and the later sectional release is already reported by the train engine.
 */

import type { SignallingContext } from './context';
import { computeAspects } from './aspects';
import type { Aspect, SignallingState } from './types';

export type ChangeCategory = 'route' | 'signal' | 'point';
export interface SignallingChange {
  readonly category: ChangeCategory;
  readonly level: 'info' | 'ok' | 'warn';
  readonly text: string;
}

const ASPECT_WORD: Record<Aspect, string> = { red: 'Danger', yellow: 'Yellow', 'double-yellow': 'Double Yellow', green: 'Green' };
const posWord = (p: string): string => (p === 'normal' ? 'Normal' : 'Reverse');
const keys = (o: Readonly<Record<string, unknown>>): string[] => Object.keys(o);

export function diffSignalling(ctx: SignallingContext, prev: SignallingState, next: SignallingState): SignallingChange[] {
  if (prev === next) return [];
  const out: SignallingChange[] = [];
  const label = (routeId: string): string => {
    const r = ctx.route(routeId);
    return r ? `${r.from} → ${r.to}` : routeId;
  };

  // routes established / cancelled
  if (prev.routes !== next.routes) {
    for (const sig of keys(next.routes)) {
      const id = next.routes[sig] as string;
      if (prev.routes[sig] !== id) out.push({ category: 'route', level: 'ok', text: `Route ${label(id)} established.` });
    }
    for (const sig of keys(prev.routes)) {
      const id = prev.routes[sig] as string;
      if (next.routes[sig] === id) continue;
      if (next.residual[id]) continue; // passed by a train: the signal returned to Danger, locks held until clear
      out.push({ category: 'route', level: 'info', text: `Route ${label(id)} cancelled.` });
    }
  }

  // points moved
  if (prev.network.pointPositions !== next.network.pointPositions) {
    for (const p of keys(next.network.pointPositions)) {
      const a = prev.network.pointPositions[p];
      const b = next.network.pointPositions[p];
      if (a !== b && b !== undefined) out.push({ category: 'point', level: 'info', text: `Point ${p} moved to ${posWord(b)}.` });
    }
  }

  // points locked / unlocked, grouped so one route is one line
  if (prev.pointLocks !== next.pointLocks) {
    const locked = new Map<string, string[]>();
    const unlocked: string[] = [];
    for (const p of keys(next.pointLocks)) {
      if (prev.pointLocks[p] !== undefined) continue;
      const route = next.pointLocks[p] as string;
      const list = locked.get(route) ?? [];
      list.push(p);
      locked.set(route, list);
    }
    for (const p of keys(prev.pointLocks)) if (next.pointLocks[p] === undefined) unlocked.push(p);
    for (const [route, pts] of locked) out.push({ category: 'point', level: 'info', text: `Point${pts.length > 1 ? 's' : ''} ${pts.join(', ')} locked for route ${label(route)}.` });
    if (unlocked.length > 0) out.push({ category: 'point', level: 'info', text: `Point${unlocked.length > 1 ? 's' : ''} ${unlocked.join(', ')} unlocked.` });
  }

  // forced Danger
  if (prev.signalOverrides !== next.signalOverrides) {
    for (const s of keys(next.signalOverrides)) if (prev.signalOverrides[s] === undefined) out.push({ category: 'signal', level: 'warn', text: `Signal ${s} forced to Danger.` });
    for (const s of keys(prev.signalOverrides)) if (next.signalOverrides[s] === undefined) out.push({ category: 'signal', level: 'ok', text: `Signal ${s} restored from forced Danger.` });
  }

  // manual signal aspects: only when something that decides them changed
  if (prev.routes !== next.routes || prev.network.sectionOccupancy !== next.network.sectionOccupancy || prev.network.pointPositions !== next.network.pointPositions || prev.signalOverrides !== next.signalOverrides) {
    const a = computeAspects(ctx, prev);
    const b = computeAspects(ctx, next);
    for (const [id, sig] of ctx.net.signals) {
      if (sig.type !== 'manual') continue;
      const was = a[id];
      const now = b[id];
      if (!was || !now || was === now) continue;
      if (was === 'red') out.push({ category: 'signal', level: 'info', text: `Signal ${id} cleared: ${ASPECT_WORD[now]}.` });
      else if (now === 'red') out.push({ category: 'signal', level: 'info', text: `Signal ${id} returned to Danger.` });
      // proceed → another proceed aspect is only the signal ahead changing: not logged
    }
  }
  return out;
}
