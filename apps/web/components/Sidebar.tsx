'use client';

import type { FindingCategory, StudioNode, StudioNodeKind } from '@rea-studio/schema';
import { useMemo, useState } from 'react';
import { displayName, isUnlikelyEndpoint, KIND_META, searchText, type ProjectIndex } from '../lib/project';
import { KindGlyph } from './KindGlyph';

const CATEGORY_KIND: Record<FindingCategory, StudioNodeKind> = {
  processes: 'process',
  windows: 'window',
  ipc: 'ipc-channel',
  'bridge-apis': 'bridge-api',
  'native-addons': 'native-addon',
  storage: 'storage',
  workers: 'worker',
  endpoints: 'endpoint',
  imports: 'external-module',
  'source-files': 'source-file',
};

const CATEGORY_LABEL: Record<FindingCategory, string> = {
  processes: 'Processes',
  windows: 'Windows',
  ipc: 'IPC channels',
  'bridge-apis': 'Bridge APIs',
  'native-addons': 'Native add-ons',
  storage: 'Storage keys',
  workers: 'Workers',
  endpoints: 'Endpoint candidates',
  imports: 'Imports',
  'source-files': 'Recovered source files',
};

type Tab = 'findings' | 'source' | 'files';

interface TreeDir {
  name: string;
  path: string;
  dirs: Map<string, TreeDir>;
  leaves: { name: string; node: StudioNode }[];
  count: number;
}

function buildTree(entries: { path: string; node: StudioNode }[]): TreeDir {
  const root: TreeDir = { name: '', path: '', dirs: new Map(), leaves: [], count: 0 };
  for (const { path, node } of entries) {
    const parts = path.split('/').filter(Boolean);
    let dir = root;
    dir.count++;
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = { name: part, path: `${dir.path}${part}/`, dirs: new Map(), leaves: [], count: 0 };
        dir.dirs.set(part, next);
      }
      next.count++;
      dir = next;
    }
    dir.leaves.push({ name: parts[parts.length - 1] ?? path, node });
  }
  return root;
}

function TreeView({ dir, depth, open, toggle, selectedId, onSelect }: { dir: TreeDir; depth: number; open: Set<string>; toggle: (p: string) => void; selectedId: string | null; onSelect: (id: string) => void }) {
  const dirs = [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const leaves = [...dir.leaves].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <ul className="tree" role={depth === 0 ? 'tree' : 'group'}>
      {dirs.map((d) => {
        const isOpen = open.has(d.path);
        return (
          <li key={d.path} role="treeitem" aria-expanded={isOpen}>
            <button type="button" className="tree__dir" style={{ paddingLeft: depth * 12 + 6 }} onClick={() => toggle(d.path)}>
              <span className="tree__caret">{isOpen ? '▾' : '▸'}</span>
              {d.name}
              <span className="muted num"> {d.count}</span>
            </button>
            {isOpen && <TreeView dir={d} depth={depth + 1} open={open} toggle={toggle} selectedId={selectedId} onSelect={onSelect} />}
          </li>
        );
      })}
      {leaves.map((l) => (
        <li key={l.node.id} role="treeitem">
          <button
            type="button"
            className={`tree__leaf ${l.node.id === selectedId ? 'is-selected' : ''}`}
            style={{ paddingLeft: depth * 12 + 20 }}
            onClick={() => onSelect(l.node.id)}
            title={displayName(l.node)}
          >
            {l.name}
          </button>
        </li>
      ))}
    </ul>
  );
}

interface Props {
  ix: ProjectIndex;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function Sidebar({ ix, selectedId, onSelect }: Props) {
  const [tab, setTab] = useState<Tab>('findings');
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<StudioNodeKind | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set(['app/', 'app/src/']));
  const toggle = (p: string) => setOpen((s) => {
    const next = new Set(s);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    return next;
  });

  const sourceTree = useMemo(() => buildTree((ix.byKind.get('source-file') ?? []).map((n) => ({ path: n.kind === 'source-file' ? n.path : n.label, node: n }))), [ix]);
  const fileTree = useMemo(
    () => buildTree((ix.byKind.get('file') ?? []).filter((n) => n.kind === 'file' && n.path !== '').map((n) => ({ path: n.kind === 'file' ? n.path : '', node: n }))),
    [ix],
  );

  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (q === '') return [];
    const out: StudioNode[] = [];
    for (const n of ix.project.nodes) {
      if (searchText(n).includes(q)) out.push(n);
      if (out.length >= 200) break;
    }
    return out;
  }, [ix, q]);

  // Endpoint candidates Studio judged unlikely (T012) stay one click away, never removed.
  const [showUnlikely, setShowUnlikely] = useState(false);
  const all = kindFilter ? ix.byKind.get(kindFilter) ?? [] : [];
  const unlikely = all.filter(isUnlikelyEndpoint);
  const listed = showUnlikely ? all : all.filter((n) => !isUnlikelyEndpoint(n));

  return (
    <nav className="sidebar" aria-label="Explorer">
      <input className="search" type="search" placeholder="Search everything…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search nodes" />

      {q !== '' ? (
        <section>
          <h4>
            Results <span className="muted">({results.length}{results.length === 200 ? '+' : ''})</span>
          </h4>
          <NodeList nodes={results} selectedId={selectedId} onSelect={onSelect} />
        </section>
      ) : (
        <>
          <div className="tabs" role="tablist">
            {(['findings', 'source', 'files'] as const).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'tab--on' : ''}`} onClick={() => setTab(t)}>
                {t === 'findings' ? 'Findings' : t === 'source' ? `Source (${sourceTree.count})` : `Files (${fileTree.count})`}
              </button>
            ))}
          </div>

          {tab === 'findings' && (
            <section>
              <ul className="findings">
                {ix.project.findings.map((f) => {
                  const kind = CATEGORY_KIND[f.category];
                  const on = kindFilter === kind;
                  return (
                    <li key={f.category}>
                      <button
                        type="button"
                        className={`finding ${f.status === 'found' ? '' : 'finding--none'} ${on ? 'finding--on' : ''}`}
                        onClick={() => setKindFilter(on ? null : kind)}
                        title={f.notes.join('\n')}
                      >
                        <KindGlyph kind={kind} />
                        <span className="finding__label">{CATEGORY_LABEL[f.category]}</span>
                        <span className="flag">{f.unresolvedCount > 0 ? `${f.unresolvedCount} unresolved` : ''}</span>
                        <span className="finding__count">{f.status === 'found' ? f.count : 'not found'}</span>
                      </button>
                      {on && f.notes.length > 0 && (
                        <ul className="finding__notes">
                          {f.notes.map((n) => (
                            <li key={n}>{n}</li>
                          ))}
                        </ul>
                      )}
                      {on && <NodeList nodes={listed} selectedId={selectedId} onSelect={onSelect} limit={300} />}
                      {on && unlikely.length > 0 && (
                        <button type="button" className="link finding__more" onClick={() => setShowUnlikely(!showUnlikely)}>
                          {showUnlikely ? `Hide the ${unlikely.length} unlikely candidates` : `Show ${unlikely.length} unlikely REA candidates`}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {(ix.byKind.get('analysis-gap')?.length ?? 0) > 0 && (
                <button type="button" className={`finding finding--gap ${kindFilter === 'analysis-gap' ? 'finding--on' : ''}`} onClick={() => setKindFilter(kindFilter === 'analysis-gap' ? null : 'analysis-gap')}>
                  <KindGlyph kind="analysis-gap" />
                  <span className="finding__label">Analysis gaps</span>
                  <span />
                  <span className="finding__count">{ix.byKind.get('analysis-gap')?.length}</span>
                </button>
              )}
              {kindFilter === 'analysis-gap' && <NodeList nodes={listed} selectedId={selectedId} onSelect={onSelect} limit={300} />}
            </section>
          )}

          {tab === 'source' &&
            (sourceTree.count === 0 ? (
              <p className="empty">No source maps with recoverable sources were found.</p>
            ) : (
              <TreeView dir={sourceTree} depth={0} open={open} toggle={toggle} selectedId={selectedId} onSelect={onSelect} />
            ))}
          {tab === 'files' && <TreeView dir={fileTree} depth={0} open={open} toggle={toggle} selectedId={selectedId} onSelect={onSelect} />}
        </>
      )}
    </nav>
  );
}

function NodeList({ nodes, selectedId, onSelect, limit = 200 }: { nodes: StudioNode[]; selectedId: string | null; onSelect: (id: string) => void; limit?: number }) {
  if (nodes.length === 0) return <p className="empty">Nothing here.</p>;
  return (
    <ul className="node-list">
      {nodes.slice(0, limit).map((n) => (
        <li key={n.id}>
          <button type="button" className={`node-list__item ${n.id === selectedId ? 'is-selected' : ''}`} onClick={() => onSelect(n.id)} title={displayName(n)}>
            <KindGlyph kind={n.kind} />
            <span className="node-list__name">{displayName(n)}</span>
            <span className={isUnlikelyEndpoint(n) ? 'flag node-list__kind' : 'muted node-list__kind'}>{isUnlikelyEndpoint(n) ? 'unlikely' : KIND_META[n.kind].label}</span>
          </button>
        </li>
      ))}
      {nodes.length > limit && <li className="muted">+{nodes.length - limit} more (use search)</li>}
    </ul>
  );
}
