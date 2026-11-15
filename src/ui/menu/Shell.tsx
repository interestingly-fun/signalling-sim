import { useCallback, useState } from 'react';
import type { ComponentType } from 'react';
import { App } from '../App';
import { NorthbridgeApp } from '../NorthbridgeApp';
import { findMap, type MapId } from './maps';
import { initialScreen, navigate, type NavAction, type Screen } from './nav';
import { MainMenu, MapInfo, MapSelect } from './screens';
import './menu.css';

/**
 * Registry of playable workstations. A map is playable exactly when it has an entry here and is not flagged
 * `planned` in maps.ts. To enable a future map: add its workstation component here and clear its `planned` flag.
 */
export type WorkstationRegistry = Partial<Record<MapId, ComponentType>>;

export const defaultWorkstations: WorkstationRegistry = { ashcombe: App, northbridge: NorthbridgeApp };

export function Shell({ workstations = defaultWorkstations }: { workstations?: WorkstationRegistry }) {
  const [screen, setScreen] = useState<Screen>(initialScreen);
  const [lastMap, setLastMap] = useState<MapId | null>(null);

  const playable = useCallback(
    (id: MapId) => {
      const m = findMap(id);
      return !!m && !!workstations[id] && !(m.planned && !workstations[id]);
    },
    [workstations],
  );
  const go = useCallback(
    (a: NavAction) => {
      if (a.type === 'open' || a.type === 'play') setLastMap(a.mapId);
      setScreen((s) => navigate(s, a, playable));
    },
    [playable],
  );

  if (screen.name === 'play') {
    const Workstation = workstations[screen.mapId];
    if (Workstation) return <Workstation />;
  }
  if (screen.name === 'select') {
    return <MapSelect highlight={lastMap} onOpen={(id) => go({ type: 'open', mapId: id })} onBack={() => go({ type: 'back' })} />;
  }
  if (screen.name === 'info') {
    const map = findMap(screen.mapId);
    if (map) {
      return (
        <MapInfo
          map={map}
          playable={playable(map.id)}
          onPlay={() => go({ type: 'play', mapId: map.id })}
          onBack={() => go({ type: 'back' })}
        />
      );
    }
  }
  return <MainMenu onStart={() => go({ type: 'start' })} />;
}
