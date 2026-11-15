import { ashcombeLayout, northbridgeLayout } from '../../layout';
import type { LayoutDef } from '../../layout';
import type { PreviewDef, Schematic } from './maps';

/** Static drawing of a layout's tracks. No signals, points state, trains or interaction. */
function AshcombePreview({ layout, name, testId }: { layout: LayoutDef; name: string; testId: string }) {
  const mL = layout.marginLeft ?? 0;
  const mR = layout.marginRight ?? 0;
  const mT = layout.marginTop ?? 0;
  const x0 = -mL;
  const y0 = -mT;
  const w = layout.width + mL + mR;
  const h = layout.height + mT;
  const lines = Object.entries(layout.sections);
  const plats = Object.entries(layout.platforms);
  // Only the named places are labelled in the preview; everything else is left out to keep it uncluttered.
  const places = layout.labels.filter((l) => l.size === 'xl' || l.size === 'lg');
  return (
    <svg
      className="preview-svg"
      viewBox={`${x0} ${y0} ${w} ${h}`}
      role="img"
      aria-label={`Static track layout of ${name}`}
      data-testid={testId}
      preserveAspectRatio="xMidYMid meet"
    >
      {plats.map(([id, r]) => (
        <rect key={id} className="pv-platform" x={r.x} y={r.y} width={r.width} height={r.height} />
      ))}
      {lines.map(([id, pts]) => (
        <polyline key={id} className="pv-track" points={pts.map((p) => `${p[0]},${p[1]}`).join(' ')} />
      ))}
      {places.map((l) => (
        <text key={l.text + l.x + l.y} className="pv-label" x={l.x} y={l.y} textAnchor={l.anchor ?? 'start'}>
          {l.text}
        </text>
      ))}
    </svg>
  );
}

function ConceptualPreview({ schematic, name }: { schematic: Schematic; name: string }) {
  return (
    <svg
      className="preview-svg"
      viewBox={`0 0 ${schematic.width} ${schematic.height}`}
      role="img"
      aria-label={`Conceptual sketch of ${name} — not a playable map`}
      data-testid="preview-conceptual"
      preserveAspectRatio="xMidYMid meet"
    >
      {schematic.lines.map((l, i) => (
        <polyline
          key={i}
          className={`pv-track pv-${l.role ?? 'main'}`}
          points={l.points.map((p) => `${p[0]},${p[1]}`).join(' ')}
        />
      ))}
      {schematic.labels.map((l) => (
        <text key={l.text} className="pv-note" x={l.x} y={l.y} textAnchor={l.anchor ?? 'start'}>
          {l.text}
        </text>
      ))}
    </svg>
  );
}

export function LayoutPreview({ preview, name }: { preview: PreviewDef; name: string }) {
  return (
    <figure className={`preview preview-${preview.kind}`}>
      <div className="preview-frame">
        {preview.kind === 'ashcombe-layout' ? (
          <AshcombePreview layout={ashcombeLayout} name="Ashcombe Junction" testId="preview-ashcombe" />
        ) : preview.kind === 'northbridge-layout' ? (
          <AshcombePreview layout={northbridgeLayout} name="Northbridge Station" testId="preview-northbridge" />
        ) : (
          <ConceptualPreview schematic={preview.schematic} name={name} />
        )}
      </div>
      <figcaption className="preview-caption" data-testid="preview-caption">
        {preview.caption}
      </figcaption>
    </figure>
  );
}
