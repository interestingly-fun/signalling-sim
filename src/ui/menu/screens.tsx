import type { MapDef, MapId } from './maps';
import { DIFFICULTIES, MAPS } from './maps';
import { LayoutPreview } from './LayoutPreview';

export function MainMenu({ onStart }: { onStart: () => void }) {
  return (
    <main className="menu-screen menu-main" data-testid="screen-menu">
      <div className="menu-rail" aria-hidden="true" />
      <div className="menu-title-block">
        <p className="menu-kicker">Railway signalling simulator</p>
        <h1 className="menu-title">Ashcombe Signalling</h1>
        <p className="menu-sub">Set routes, hold the line, keep the timetable.</p>
        <button type="button" className="menu-start" data-testid="menu-start" onClick={onStart} autoFocus>
          Start
        </button>
      </div>
      <p className="menu-foot">Educational simulation — not a certified signalling system.</p>
    </main>
  );
}

export function MapSelect({
  onOpen,
  onBack,
  highlight,
}: {
  onOpen: (id: MapId) => void;
  onBack: () => void;
  highlight?: MapId | null;
}) {
  return (
    <main className="menu-screen menu-select" data-testid="screen-select">
      <header className="menu-bar">
        <button type="button" className="menu-back" data-testid="select-back" onClick={onBack}>
          ← Main menu
        </button>
        <h2 className="menu-heading">Select a map</h2>
      </header>
      <ul className="map-line" aria-label="Maps">
        {MAPS.map((m) => {
          const d = DIFFICULTIES[m.difficulty];
          return (
            <li key={m.id} className="map-item">
              <button
                type="button"
                className={`map-node${highlight === m.id ? ' is-selected' : ''}`}
                data-testid={`map-${m.id}`}
                aria-label={`${m.name}, difficulty ${d.label}${m.planned ? ', coming soon' : ''}`}
                onClick={() => onOpen(m.id)}
              />
              <div className="map-text" onClick={() => onOpen(m.id)}>
                <span className="map-name">{m.name}</span>
                <span className="map-diff" style={{ color: d.colour }}>
                  {d.label}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </main>
  );
}

export function MapInfo({
  map,
  playable,
  onPlay,
  onBack,
}: {
  map: MapDef;
  playable: boolean;
  onPlay: () => void;
  onBack: () => void;
}) {
  const d = DIFFICULTIES[map.difficulty];
  return (
    <main className="menu-screen menu-info" data-testid="screen-info" data-map={map.id}>
      <header className="menu-bar">
        <button type="button" className="menu-back" data-testid="info-back" onClick={onBack}>
          ← Select a map
        </button>
      </header>
      <div className="info-grid">
        <section className="info-text">
          <h2 className="info-name" data-testid="info-name">
            {map.name}
          </h2>
          <p className="info-meta">
            <span className="info-diff" data-testid="info-difficulty" style={{ color: d.colour, borderColor: d.colour }}>
              {d.label}
            </span>
            <span className={`info-status ${playable ? 'is-available' : 'is-soon'}`} data-testid="info-status">
              {playable ? 'Playable' : 'Coming soon'}
            </span>
          </p>
          <p className="info-desc" data-testid="info-description">
            {map.description}
          </p>
          <ul className="info-features" data-testid="info-features">
            {map.features.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <div className="info-actions">
            <button
              type="button"
              className="menu-start"
              data-testid="info-start"
              disabled={!playable}
              aria-describedby={playable ? undefined : 'soon-note'}
              onClick={onPlay}
            >
              {playable ? 'Start' : 'Coming soon'}
            </button>
            {!playable && (
              <p id="soon-note" className="info-soon" data-testid="info-soon">
                This map is not implemented yet, so it cannot be started.
              </p>
            )}
          </div>
        </section>
        <section className="info-preview">
          <LayoutPreview preview={map.preview} name={map.name} />
        </section>
      </div>
    </main>
  );
}
