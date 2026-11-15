/**
 * Pure navigation for the menu shell. Screens live in memory only; nothing here touches the simulation.
 *
 * menu --start--> select --open(map)--> info(map) --play(map)--> play(map)
 *   ^               ^  back                |  back
 *   +---back--------+----------------------+
 *
 * `play` has no back transition: leaving a running workstation would silently discard the shift.
 */
import type { MapId } from './maps';

export type Screen =
  | { readonly name: 'menu' }
  | { readonly name: 'select' }
  | { readonly name: 'info'; readonly mapId: MapId }
  | { readonly name: 'play'; readonly mapId: MapId };

export type NavAction =
  | { readonly type: 'start' }
  | { readonly type: 'open'; readonly mapId: MapId }
  | { readonly type: 'play'; readonly mapId: MapId }
  | { readonly type: 'back' };

export const initialScreen: Screen = { name: 'menu' };

/** `playable` decides whether a map may be launched; an unplayable map's `play` action is ignored. */
export function navigate(screen: Screen, action: NavAction, playable: (id: MapId) => boolean): Screen {
  switch (action.type) {
    case 'start':
      return screen.name === 'menu' ? { name: 'select' } : screen;
    case 'open':
      return screen.name === 'select' ? { name: 'info', mapId: action.mapId } : screen;
    case 'play':
      return screen.name === 'info' && screen.mapId === action.mapId && playable(action.mapId)
        ? { name: 'play', mapId: action.mapId }
        : screen;
    case 'back':
      if (screen.name === 'info') return { name: 'select' };
      if (screen.name === 'select') return { name: 'menu' };
      return screen;
  }
}
