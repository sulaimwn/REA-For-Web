'use client';

import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, type Node } from '@xyflow/react';
import { useEffect, useMemo } from 'react';
import { buildView, type Focus, type KindNodeData } from '../lib/graph-view';
import { displayName, type ProjectIndex } from '../lib/project';
import { KindNode } from './KindNode';

const nodeTypes = { kind: KindNode };

interface Props {
  ix: ProjectIndex;
  focus: Focus;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onFocus: (focus: Focus) => void;
}

/** Re-fits once React Flow has measured the nodes of a new view. */
function FitOnChange({ token }: { token: string }) {
  const { fitView } = useReactFlow();
  const measured = useNodesInitialized();
  useEffect(() => {
    if (measured) void fitView({ padding: 0.12, maxZoom: 1.2, duration: 200 });
  }, [token, measured, fitView]);
  return null;
}

export function GraphPane({ ix, focus, selectedId, onSelect, onFocus }: Props) {
  // Layout depends only on what's in view, not on selection; selection is applied below.
  const view = useMemo(() => buildView(ix, focus), [ix, focus]);
  const nodes = useMemo(() => view.nodes.map((n) => ({ ...n, selected: n.id === selectedId })), [view, selectedId]);
  const focusNode = focus.mode === 'node' ? ix.byId.get(focus.id) : undefined;
  const token = focus.mode === 'overview' ? 'overview' : focus.mode === 'set' ? `set:${focus.ids.join(',')}` : focus.id;

  return (
    <section className="graph-pane" aria-label="Graph">
      <div className="graph-pane__bar">
        <button type="button" className={`chip ${focus.mode === 'overview' ? 'chip--on' : ''}`} onClick={() => onFocus({ mode: 'overview' })}>
          Architecture overview
        </button>
        {focus.mode === 'set' && (
          <span className="graph-pane__crumb">
            › <strong>{focus.label}</strong>
          </span>
        )}
        {focusNode && (
          <span className="graph-pane__crumb">
            › Neighborhood of <strong>{displayName(focusNode)}</strong>
          </span>
        )}
        <span className="graph-pane__meta">
          {view.nodes.length} nodes · {view.edges.length} links
          {view.hidden > 0 && ` · ${view.hidden} more neighbors hidden (see inspector)`}
        </span>
      </div>
      {view.nodes.length === 0 ? (
        <div className="empty">Nothing to draw for this view.</div>
      ) : (
        <ReactFlowProvider key={token}>
          <ReactFlow
            nodes={nodes}
            edges={view.edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, n: Node<KindNodeData>) => onSelect(n.id)}
            onNodeDoubleClick={(_, n: Node<KindNodeData>) => onFocus({ mode: 'node', id: n.id })}
            nodesConnectable={false}
            nodesDraggable
            minZoom={0.1}
            proOptions={{ hideAttribution: false }}
            colorMode="dark"
            fitView
            fitViewOptions={{ padding: 0.12, maxZoom: 1.2 }}
          >
            <FitOnChange token={token} />
            <Background gap={24} />
            <MiniMap pannable zoomable nodeColor={() => '#3b4252'} maskColor="rgba(10,12,16,0.6)" style={{ width: 150, height: 100 }} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </ReactFlowProvider>
      )}
      <p className="graph-pane__hint">Click a node to inspect it. Double-click to see its neighborhood.</p>
    </section>
  );
}
