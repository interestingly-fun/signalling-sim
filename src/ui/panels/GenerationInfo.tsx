import { useSyncExternalStore } from 'react';
import { DIFFICULTIES, analyseTraffic, type DifficultyId, type GenerationReport, type SignallingContext } from '../../engine';
import type { ShiftController } from '../sim/shift';

interface Props {
  readonly ctx: SignallingContext;
  readonly shift: ShiftController;
}

/**
 * Testing information only (Phase 10): how the shift on show was generated and what it asks of the signaller.
 * Read-only; shown inside the testing section, never in the operational display.
 */
export function GenerationInfo({ ctx, shift }: Props) {
  useSyncExternalStore(shift.subscribe, shift.getVersion);
  const tt = shift.timetable;
  if (!tt) return <div className="panel-body gen-info" data-testid="generation-info">No timetable generated yet.</div>;
  const report: GenerationReport | undefined = tt.report;
  const stats = report?.stats ?? analyseTraffic(ctx, tt.services);
  const diff = tt.difficulty ? DIFFICULTIES[tt.difficulty as DifficultyId] : undefined;
  const range = report?.targetRange ?? diff?.countRange;
  const k = stats.byKind;
  return (
    <div className="panel-body gen-info" data-testid="generation-info">
      <strong>Generation</strong> · difficulty {diff?.label ?? tt.difficulty ?? 'unknown'} · seed {tt.seed} · services {tt.services.length}
      {range ? ` (target ${range[0]}–${range[1]}${report && report.requested !== report.generated ? `, aimed for ${report.requested}` : ''})` : ''}
      {tt.usedFallback ? ' · fallback timetable' : ''}
      <div>
        Most trains in the area together: {stats.maxConcurrent} · overlapping pairs: {stats.overlappingPairs} · independent simultaneous: {stats.independentSimultaneous} · junction interactions: {stats.junctionInteractions} · closely sequenced:{' '}
        {stats.closeSequences}
      </div>
      <div>
        Overlap kinds: opposing directions {k.opposing} · express past stopping train {k['express-local']} · branch beside main line {k['branch-main']} · ECS beside passengers {k['ecs-passenger']}
      </div>
      {report && report.reductionReasons.length > 0 ? (
        <div className="gen-warn">
          Target not met: {report.reductionReasons.join(' ')}
        </div>
      ) : null}
      {report && report.revisions.length > 0 ? (
        <details>
          <summary>Rejected or revised ({report.revisions.length})</summary>
          <ul>
            {report.revisions.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </details>
      ) : (
        <div>No services were rejected or revised.</div>
      )}
    </div>
  );
}
