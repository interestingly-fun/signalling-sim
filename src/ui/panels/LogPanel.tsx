import { useState, useSyncExternalStore } from 'react';
import { LOG_CATEGORIES, type EventLog, type LogCategory, type LogEntry } from '../sim/eventLog';

const ALL = new Set<LogCategory>(LOG_CATEGORIES.map((c) => c.id));

/** One entry per line: simulation time, category, message. Shared by the live log and shift records. */
export function LogLines({ entries, empty }: { entries: readonly LogEntry[]; empty: string }) {
  if (entries.length === 0) return <p className="muted log-empty">{empty}</p>;
  return (
    <ul className="message-log" aria-label="Events">
      {entries.map((e) => (
        <li key={e.seq} className={`log-${e.level}`} data-category={e.category}>
          <span className="log-time">{e.clock}</span>
          <span className={`log-cat cat-${e.category}`}>{LOG_CATEGORIES.find((c) => c.id === e.category)?.label ?? e.category}</span>
          <span className="log-text">{e.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** The live event log with category filters and a Clear that only hides what is shown. */
export function LogPanel({ log }: { log: EventLog }) {
  useSyncExternalStore(log.subscribe, log.getVersion);
  const [active, setActive] = useState<ReadonlySet<LogCategory>>(ALL);
  const toggle = (id: LogCategory) => {
    const next = new Set(active);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setActive(next);
  };
  const entries = log.visible(active);
  const hidden = log.hiddenCount;
  return (
    <section className="panel log-panel" aria-label="Event log" data-testid="log-panel">
      <h2>Event log</h2>
      <div className="panel-body log-body">
        <div className="log-filters" role="group" aria-label="Filter events by category">
          {LOG_CATEGORIES.map((c) => (
            <button key={c.id} type="button" className={`filter-chip cat-${c.id}${active.has(c.id) ? ' on' : ''}`} aria-pressed={active.has(c.id)} onClick={() => toggle(c.id)} data-testid={`filter-${c.id}`}>
              {c.label}
            </button>
          ))}
          <button type="button" className="mini" onClick={() => setActive(ALL)} disabled={active.size === ALL.size} data-testid="filter-all">
            All
          </button>
          <span className="spacer" />
          <button type="button" className="mini" onClick={() => log.clearVisible()} disabled={entries.length === 0 && hidden === 0} title="Hides the entries shown. The simulation and shift records are not affected." data-testid="clear-log">
            Clear view
          </button>
        </div>
        <LogLines entries={entries} empty={hidden > 0 ? 'View cleared. New events will appear here.' : 'No events yet.'} />
        {hidden > 0 ? <p className="note log-note">{hidden} earlier event{hidden === 1 ? '' : 's'} hidden by Clear; they are still in the shift record.</p> : null}
      </div>
    </section>
  );
}
