'use client';

import type { Evidence, StudioEdge, StudioNode } from '@rea-studio/schema';
import { useMemo, useState } from 'react';
import type { Focus } from '../lib/graph-view';
import { displayName, KIND_META, KIND_ORDER, type ProjectIndex } from '../lib/project';
import { KindGlyph } from './KindGlyph';

interface Props {
  ix: ProjectIndex;
  node: StudioNode | null;
  onSelect: (id: string) => void;
  onFocus: (focus: Focus) => void;
}

type Fact = [label: string, value: string | number | boolean | null | undefined];

function facts(n: StudioNode): Fact[] {
  switch (n.kind) {
    case 'process':
      return [['Role', n.role], ['Entry file', n.path], ['Declared as', n.declaredPath], ['Found via', n.mechanism]];
    case 'window':
      return [['Created in', n.sourcePath], ['Preload', n.preloadPath ?? 'none found'], ...n.webPreferences.map((w): Fact => [`webPreferences.${w.name}`, w.value === null ? w.expression ?? w.status : String(w.value)])];
    case 'bridge-api':
      return [['Exposed as', `window.${n.apiKey ?? '?'}`], ['Members', n.members.join(', ') || 'none found'], ['Unresolved members', n.unknownMemberCount], ['World', n.world]];
    case 'ipc-channel':
      return [
        ['Channel', n.channel ?? 'unknown at static time'],
        ['Channel expression', n.channelExpression],
        ['Resolution', n.resolution],
        ['Used as', n.usages.map((u) => `${u.side} ${u.operation}`).join(', ')],
      ];
    case 'ipc-handler':
      return [['Side', n.side], ['Registration', n.operation], ['Channel', n.channel ?? n.channelExpression], ['Handler', n.handlerKind]];
    case 'native-addon':
      return [['Path', n.path], ['Size', n.bytes === null ? null : `${(n.bytes / 1024).toFixed(0)} KB`]];
    case 'endpoint':
      return [['Value', n.value], ['Kind', n.endpointKind], ['Found via', n.mechanism], ['Note', 'REA candidate, unfiltered; may not be a real endpoint']];
    case 'storage':
      return [['Key', n.name], ['Kind', n.storageKind], ['Found via', n.mechanism]];
    case 'worker':
      return [['Expression', n.expression], ['Resolved to', n.resolvedPath ?? 'unresolved']];
    case 'file':
      return [
        ['Path', n.path || '(artifact root)'],
        ['Type', n.fileKind],
        ['Size', n.bytes === null ? null : `${(n.bytes / 1024).toFixed(1)} KB`],
        ['Parse', n.parseStatus],
        ['Analysis issue', n.analysisIssue ? `${n.analysisIssue.code}: ${n.analysisIssue.message}` : null],
      ];
    case 'source-file':
      return [['Original name', n.originalName], ['From source map', n.sourceMapPath], ['Content in map', n.contentAvailable], ['Note', 'REA 6.4.0 gives recovered source files no import edges']];
    case 'source-map':
      return [['Path', n.path], ['Shipped', n.available]];
    case 'module':
      return [['Path', n.path], ['Format', n.format], ['Exports', n.exportNames.join(', ') || null], ['Bundler', n.bundler ? `${n.bundler.name} (${n.bundler.moduleKey})` : null]];
    case 'external-module':
      return [['Specifier', n.specifier], ['Resolution', n.resolution], ['Import sites', n.evidence.length]];
    case 'bundle-chunk':
      return [['Path', n.path], ['Bundler', `${n.bundler} / ${n.runtime}`], ['Modules', n.moduleCount]];
    case 'package':
      return [['Name', n.name], ['Version', n.version], ['Main', n.main], ['Path', n.path]];
    case 'analysis-gap':
      return [['Path', n.path], ['Operation', n.operation], ['Failure', n.failure ? `${n.failure.code}: ${n.failure.message}` : null]];
  }
}

const STATE_LABEL: Record<Evidence['state'], string> = {
  observed: 'Observed',
  inferred: 'Inferred',
  unavailable: 'Unavailable',
};

function EvidenceCard({ ev }: { ev: Evidence }) {
  const loc = ev.location;
  const where = !loc ? 'no location' : loc.kind === 'source-range' ? `${loc.file}:${loc.start.line}:${loc.start.column}` : loc.file;
  return (
    <li className={`evidence evidence--${ev.state}`}>
      <div className="evidence__head">
        <span className={`line ${ev.state === 'observed' ? '' : 'line--inferred'}`} aria-hidden="true" />
        <span className="evidence__state">{STATE_LABEL[ev.state]}</span>
        <span className="evidence__conf">{ev.confidence} confidence</span>
      </div>
      <code className="evidence__where">{where}</code>
      <div className="evidence__meta">
        {ev.extractor} · {ev.authority}
      </div>
      {ev.limitations.length > 0 && (
        <details className="evidence__limits">
          <summary>{ev.limitations.length} limitation{ev.limitations.length === 1 ? '' : 's'}</summary>
          <ul>
            {ev.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

const SHOW = 25;

function EvidenceList({ records }: { records: Evidence[] }) {
  const [shown, setShown] = useState(20);
  return <>
    <ul className="evidence-list">
      {records.slice(0, shown).map((ev, i) => <EvidenceCard key={i} ev={ev} />)}
    </ul>
    {shown < records.length && <button type="button" className="link muted" onClick={() => setShown(count => count + 20)}>
      Show more evidence ({records.length - shown} remaining)
    </button>}
  </>;
}

function Relations({ ix, title, edges, other, onSelect }: { ix: ProjectIndex; title: string; edges: StudioEdge[]; other: (e: StudioEdge) => string; onSelect: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const sorted = useMemo(() => {
    const rank = (e: StudioEdge) => KIND_ORDER.indexOf(ix.byId.get(other(e))?.kind ?? 'analysis-gap');
    return [...edges].sort((a, b) => rank(a) - rank(b));
  }, [edges, ix, other]);
  if (edges.length === 0) return null;
  const shown = all ? sorted : sorted.slice(0, SHOW);
  return (
    <div className="relations">
      <h4>
        {title} <span className="muted">({edges.length})</span>
      </h4>
      <ul>
        {shown.map((e) => {
          const n = ix.byId.get(other(e));
          if (!n) return null;
          return (
            <li key={e.id}>
              <span className={`rel-name ${e.evidence.state === 'observed' ? '' : 'rel-name--inferred'}`}>{e.relation}</span>
              {e.origin.source === 'studio-heuristic' && (
                <span className="rel-heur" title={e.origin.basis}>
                  heuristic
                </span>
              )}
              <button type="button" className="link" onClick={() => onSelect(n.id)} title={KIND_META[n.kind].label}>
                <KindGlyph kind={n.kind} />
                <span className="relations__name">{displayName(n)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {edges.length > SHOW && (
        <button type="button" className="link muted" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${edges.length}`}
        </button>
      )}
    </div>
  );
}

export function Inspector({ ix, node, onSelect, onFocus }: Props) {
  if (!node) {
    return (
      <aside className="inspector" aria-label="Inspector">
        <div className="empty">
          Select something to see what REA found about it and the evidence behind each fact.
        </div>
      </aside>
    );
  }
  const meta = KIND_META[node.kind];
  const out = ix.outgoing.get(node.id) ?? [];
  const inc = ix.incoming.get(node.id) ?? [];
  return (
    <aside className="inspector" aria-label="Inspector">
      <header className="inspector__head">
        <div className="inspector__kind">
          <KindGlyph kind={node.kind} />
          {meta.label}
          <span className={`inspector__origin ${node.origin.source === 'rea' ? '' : 'inspector__origin--heuristic'}`}>
            {node.origin.source === 'rea' ? 'Found by REA' : 'Studio heuristic'}
          </span>
        </div>
        <h3 className="inspector__title">{displayName(node)}</h3>
        <button type="button" className="btn" onClick={() => onFocus({ mode: 'node', id: node.id })}>
          Show neighborhood in graph
        </button>
      </header>

      <dl className="facts">
        {facts(node)
          .filter(([, v]) => v !== null && v !== undefined && v !== '')
          .map(([k, v]) => (
            <div key={k} className="facts__row">
              <dt>{k}</dt>
              <dd>{String(v)}</dd>
            </div>
          ))}
      </dl>

      <h4>
        Evidence <span className="muted">({node.evidence.length})</span>
      </h4>
      <EvidenceList key={node.id} records={node.evidence} />

      <Relations key={`out-${node.id}`} ix={ix} title="Outgoing" edges={out} other={(e) => e.target} onSelect={onSelect} />
      <Relations key={`in-${node.id}`} ix={ix} title="Incoming" edges={inc} other={(e) => e.source} onSelect={onSelect} />
    </aside>
  );
}
