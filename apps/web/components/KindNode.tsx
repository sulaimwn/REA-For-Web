'use client';

import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { KindNodeData } from '../lib/graph-view';
import { displayName, KIND_META } from '../lib/project';

export function KindNode({ data, selected }: NodeProps<Node<KindNodeData>>) {
  const n = data.node;
  const meta = KIND_META[n.kind];
  const unresolved = n.kind === 'ipc-channel' && n.resolution === 'dynamic';
  return (
    <div
      className={`kind-node ${selected ? 'is-selected' : ''} ${data.focused ? 'is-focused' : ''} ${n.kind === 'analysis-gap' ? 'is-gap' : ''}`}
      style={{ ['--accent' as string]: meta.color }}
      title={displayName(n)}
    >
      <Handle type="target" position={data.dir === 'LR' ? Position.Left : Position.Top} />
      <div className="kind-node__kind">
        {meta.label}
        {unresolved && <span className="kind-node__flag">unresolved</span>}
      </div>
      <div className="kind-node__name">{displayName(n)}</div>
      <Handle type="source" position={data.dir === 'LR' ? Position.Right : Position.Bottom} />
    </div>
  );
}
