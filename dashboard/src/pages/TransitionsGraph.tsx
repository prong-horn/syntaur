import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AlertTriangle, HelpCircle, Flag } from 'lucide-react';
import { cn } from '../lib/utils';
import type { GraphStatusNode, GraphTransitionEdge } from './transitions-helpers';

// ── Layout ───────────────────────────────────────────────────────────────
// Deterministic grid: defined statuses (in display order) then ghost nodes
// fill columns top-to-bottom, left-to-right. Positions aren't persisted
// (YAGNI); users can drag, and drags survive prop-driven rebuilds via a
// per-id position cache.
const ROWS_PER_COL = 4;
const COL_W = 230;
const ROW_H = 120;

function gridPosition(index: number): { x: number; y: number } {
  const col = Math.floor(index / ROWS_PER_COL);
  const row = index % ROWS_PER_COL;
  return { x: col * COL_W, y: row * ROW_H };
}

type StatusNodeData = {
  label: string;
  statusId: string;
  color?: string;
  terminal: boolean;
  orphan: boolean;
  missing: boolean;
};

// nodeTypes must be a stable reference — defined at module scope so ReactFlow
// doesn't warn about recreating it each render.
function StatusNodeView({ data, selected }: NodeProps<Node<StatusNodeData>>) {
  const { label, statusId, color, terminal, orphan, missing } = data;
  return (
    <div
      className={cn(
        'min-w-[120px] rounded-md border px-3 py-2 text-xs shadow-sm transition-colors',
        missing
          ? 'border-dashed border-error-foreground/60 bg-error/10 text-error-foreground'
          : orphan
            ? 'border-warning-foreground/70 bg-warning/10'
            : 'border-border/70 bg-card',
        selected && 'ring-2 ring-primary/50',
      )}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !bg-muted-foreground" />
      <div className="flex items-center gap-1.5">
        {!missing && (
          <span
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-border/50"
            style={color ? { backgroundColor: color } : undefined}
          />
        )}
        <span className="font-medium text-foreground">{label}</span>
        {missing && <HelpCircle className="h-3 w-3 shrink-0" aria-label="Undefined status" />}
        {orphan && !missing && (
          <AlertTriangle className="h-3 w-3 shrink-0 text-warning-foreground" aria-label="Orphan status" />
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
        <span>{statusId}</span>
        {terminal && (
          <span className="inline-flex items-center gap-0.5 text-muted-foreground" title="Terminal status">
            <Flag className="h-2.5 w-2.5" /> terminal
          </span>
        )}
      </div>
      {missing && <div className="mt-1 text-[10px] font-medium">undefined status</div>}
      {orphan && !missing && <div className="mt-1 text-[10px] text-warning-foreground">no incoming edge</div>}
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !bg-muted-foreground" />
    </div>
  );
}

const NODE_TYPES = { status: StatusNodeView };

const COLOR_NORMAL = 'oklch(var(--muted-foreground))';
const COLOR_SELECTED = 'oklch(var(--primary))';
const COLOR_UNDEFINED = 'oklch(var(--error-foreground))';

export interface TransitionsGraphProps {
  nodes: GraphStatusNode[];
  edges: GraphTransitionEdge[];
  selectedRowKey: string | null;
  /** When false, the canvas is read-only: no connecting, no deletion. */
  editable: boolean;
  onSelectEdge: (rowKey: string) => void;
  onCreateEdge: (from: string, to: string) => void;
  onDeleteEdge: (rowKey: string) => void;
}

export function TransitionsGraph({
  nodes,
  edges,
  selectedRowKey,
  editable,
  onSelectEdge,
  onCreateEdge,
  onDeleteEdge,
}: TransitionsGraphProps) {
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node<StatusNodeData>>([]);
  const [rfEdges, setRfEdges] = useEdgesState<Edge>([]);
  // Cache dragged positions by status id so prop-driven rebuilds don't reset them.
  const positions = useRef(new Map<string, { x: number; y: number }>());

  // Rebuild nodes whenever the derived node set changes (by content signature).
  const nodeSig = useMemo(
    () => nodes.map((n) => `${n.id}:${n.orphan ? 1 : 0}${n.missing ? 1 : 0}${n.terminal ? 1 : 0}${n.color ?? ''}`).join('|'),
    [nodes],
  );
  useEffect(() => {
    setRfNodes(
      nodes.map((n, i) => ({
        id: n.id,
        type: 'status',
        position: positions.current.get(n.id) ?? gridPosition(i),
        data: {
          label: n.label,
          statusId: n.id,
          color: n.color,
          terminal: n.terminal,
          orphan: n.orphan,
          missing: n.missing,
        },
        draggable: true,
        deletable: false,
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeSig, setRfNodes]);

  // Rebuild edges whenever the derived edges or selection change.
  const edgeSig = useMemo(
    () => edges.map((e) => `${e.rowKey}:${e.from}>${e.to}:${e.command}:${e.requiresReason ? 1 : 0}:${e.undefinedRef ? 1 : 0}`).join('|'),
    [edges],
  );
  useEffect(() => {
    setRfEdges(
      edges.map((e) => {
        const selected = e.rowKey === selectedRowKey;
        const stroke = e.undefinedRef ? COLOR_UNDEFINED : selected ? COLOR_SELECTED : COLOR_NORMAL;
        return {
          id: e.rowKey,
          source: e.from,
          target: e.to,
          label: e.requiresReason ? `${e.command} (reason)` : e.command,
          selected,
          deletable: editable,
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
          style: { stroke, strokeWidth: selected ? 2.5 : 1.5 },
          labelStyle: { fill: 'oklch(var(--foreground))', fontSize: 11, fontFamily: 'ui-monospace, monospace' },
          labelBgStyle: { fill: 'oklch(var(--card))' },
          labelBgPadding: [4, 2] as [number, number],
          labelBgBorderRadius: 4,
        } satisfies Edge;
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edgeSig, selectedRowKey, editable, setRfEdges]);

  // Persist drag positions into the cache.
  const handleNodesChange = useCallback(
    (changes: NodeChange<Node<StatusNodeData>>[]) => {
      for (const c of changes) {
        if (c.type === 'position' && c.position) positions.current.set(c.id, c.position);
      }
      onNodesChange(changes);
    },
    [onNodesChange],
  );

  const handleConnect = useCallback(
    (c: Connection) => {
      if (editable && c.source && c.target) onCreateEdge(c.source, c.target);
    },
    [editable, onCreateEdge],
  );

  const handleEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      if (!editable) return;
      for (const e of deleted) onDeleteEdge(e.id);
    },
    [editable, onDeleteEdge],
  );

  const handleEdgeClick = useCallback(
    (_: unknown, edge: Edge) => onSelectEdge(edge.id),
    [onSelectEdge],
  );

  return (
    <div className="h-[460px] w-full overflow-hidden rounded-md border border-border/60 bg-background">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={NODE_TYPES}
        onNodesChange={handleNodesChange}
        onConnect={handleConnect}
        onEdgesDelete={handleEdgesDelete}
        onEdgeClick={handleEdgeClick}
        nodesConnectable={editable}
        deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: false }}
      >
        <Background gap={16} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
