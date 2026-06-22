import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Panel,
  Handle,
  Position,
  getBezierPath,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  type EdgeProps,
  type Connection,
  type NodeProps,
  type NodeChange,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AlertTriangle, HelpCircle, Flag, LayoutGrid } from 'lucide-react';
import { cn } from '../lib/utils';
import type { GraphStatusNode, GraphTransitionEdge, StatusOption } from './transitions-helpers';
import { layoutGraph } from './transitions-graph-layout';
import {
  bundleEdges,
  classifyEdge,
  computeFocusSet,
  spineRankEdges,
  statusRankMap,
  type BundledCommand,
  type EdgeClass,
} from './transitions-graph-style';

type StatusNodeData = {
  label: string;
  statusId: string;
  color?: string;
  terminal: boolean;
  orphan: boolean;
  missing: boolean;
  dimmed: boolean;
};

function StatusNodeView({ data, selected }: NodeProps<Node<StatusNodeData>>) {
  const { label, statusId, color, terminal, orphan, missing, dimmed } = data;
  return (
    <div
      className={cn(
        'min-w-[120px] rounded-md border px-3 py-2 text-xs shadow-sm transition-[opacity,box-shadow]',
        missing
          ? 'border-dashed border-error-foreground/60 bg-error/10 text-error-foreground'
          : orphan
            ? 'border-warning-foreground/70 bg-warning/10'
            : 'border-border/70 bg-card',
        selected && 'ring-2 ring-primary/50',
        dimmed && 'opacity-25',
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

// ── Semantic edge color ──────────────────────────────────────────────────────
// Forward = neutral, exception (fail/block) = amber, recovery (reopen/unblock) =
// muted + dashed, undefined ref = error, selected = primary. Tokens resolve in
// both light and dark themes.
function edgeColor(edgeClass: EdgeClass, undefinedRef: boolean, selected: boolean): string {
  if (undefinedRef) return 'oklch(var(--error-foreground))';
  if (selected) return 'oklch(var(--primary))';
  if (edgeClass === 'exception') return 'oklch(var(--warning-foreground))';
  return 'oklch(var(--muted-foreground))';
}

type TransitionEdgeData = {
  from: string;
  to: string;
  commands: BundledCommand[];
  edgeClass: EdgeClass;
  undefinedRef: boolean;
  selected: boolean;
  dimmed: boolean;
  showChips: boolean;
  selectedRowKey: string | null;
  onSelectCommand: (rowKey: string) => void;
};

function TransitionEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  const d = data as TransitionEdgeData;
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const color = edgeColor(d.edgeClass, d.undefinedRef, d.selected);
  const dashed = d.edgeClass === 'recovery';
  const markerId = `arrow-${d.edgeClass}${d.undefinedRef ? '-undef' : d.selected ? '-sel' : ''}`;
  // Offset the chip cluster perpendicular to the edge so a bidirectional pair
  // (A→B and B→A) separates instead of stacking at the shared midpoint. Sign is
  // deterministic per direction (from<to vs from>to) so the two go opposite ways.
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const len = Math.hypot(dx, dy) || 1;
  const sign = d.from < d.to ? 1 : -1;
  const labelXo = labelX + (-dy / len) * 16 * sign;
  const labelYo = labelY + (dx / len) * 16 * sign;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={`url(#${markerId})`}
        style={{
          stroke: color,
          strokeWidth: d.selected ? 2.5 : 1.5,
          strokeDasharray: dashed ? '6 4' : undefined,
          opacity: d.dimmed ? 0.18 : 1,
        }}
      />
      {d.showChips && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelXo}px, ${labelYo}px)`,
              pointerEvents: 'all',
            }}
            className="flex flex-col items-center gap-0.5"
          >
            {d.commands.map((c) => {
              const active = c.rowKey === d.selectedRowKey;
              return (
                <button
                  key={c.rowKey}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    d.onSelectCommand(c.rowKey);
                  }}
                  aria-label={`Edit transition command ${c.command}`}
                  className={cn(
                    'rounded border px-1 py-0.5 font-mono text-[10px] leading-none shadow-sm transition-colors',
                    c.undefinedRef
                      ? 'border-error-foreground/70 bg-error/10 text-error-foreground'
                      : active
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border/60 bg-card text-foreground hover:border-primary/60',
                  )}
                >
                  {c.command}
                  {c.requiresReason ? ' ⓡ' : ''}
                </button>
              );
            })}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const NODE_TYPES = { status: StatusNodeView };
const EDGE_TYPES = { transition: TransitionEdge };

// Per-class arrowhead markers (BaseEdge references them by id). One per
// (class, undefined|selected) combination the edges actually emit.
function ArrowMarkers() {
  const defs: Array<{ id: string; color: string }> = [
    { id: 'arrow-forward', color: edgeColor('forward', false, false) },
    { id: 'arrow-exception', color: edgeColor('exception', false, false) },
    { id: 'arrow-recovery', color: edgeColor('recovery', false, false) },
    { id: 'arrow-forward-undef', color: edgeColor('forward', true, false) },
    { id: 'arrow-exception-undef', color: edgeColor('exception', true, false) },
    { id: 'arrow-recovery-undef', color: edgeColor('recovery', true, false) },
    { id: 'arrow-forward-sel', color: edgeColor('forward', false, true) },
    { id: 'arrow-exception-sel', color: edgeColor('exception', false, true) },
    { id: 'arrow-recovery-sel', color: edgeColor('recovery', false, true) },
  ];
  return (
    <svg style={{ position: 'absolute', width: 0, height: 0 }} aria-hidden>
      <defs>
        {defs.map(({ id, color }) => (
          <marker
            key={id}
            id={id}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
          </marker>
        ))}
      </defs>
    </svg>
  );
}

function RelayoutPanel({ onRelayout }: { onRelayout: () => void }) {
  const { fitView } = useReactFlow();
  return (
    <Panel position="top-right">
      <button
        type="button"
        onClick={() => {
          onRelayout();
          requestAnimationFrame(() => fitView({ padding: 0.2 }));
        }}
        className="shell-action inline-flex items-center gap-1 text-xs"
        title="Reset node positions to the automatic layout"
      >
        <LayoutGrid className="h-3 w-3" />
        Re-layout
      </button>
    </Panel>
  );
}

// Bundle classification: precedence exception > recovery > forward, so a mixed
// status-pair reads by its most notable edge.
function bundleClass(
  commands: BundledCommand[],
  from: string,
  to: string,
  rank: Map<string, number>,
): EdgeClass {
  let hasRecovery = false;
  for (const c of commands) {
    const cls = classifyEdge({ from, to, command: c.command }, rank);
    if (cls === 'exception') return 'exception';
    if (cls === 'recovery') hasRecovery = true;
  }
  return hasRecovery ? 'recovery' : 'forward';
}

export interface TransitionsGraphProps {
  nodes: GraphStatusNode[];
  edges: GraphTransitionEdge[];
  statuses: StatusOption[];
  selectedRowKey: string | null;
  focusNodeId: string | null;
  /** When false, the canvas is read-only: no connecting, no deletion. */
  editable: boolean;
  onSelectEdge: (rowKey: string) => void;
  onFocusNode: (nodeId: string | null) => void;
  onCreateEdge: (from: string, to: string) => void;
  onDeleteEdge: (rowKeys: string[]) => void;
}

export function TransitionsGraph({
  nodes,
  edges,
  statuses,
  selectedRowKey,
  focusNodeId,
  editable,
  onSelectEdge,
  onFocusNode,
  onCreateEdge,
  onDeleteEdge,
}: TransitionsGraphProps) {
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node<StatusNodeData>>([]);
  const [rfEdges, setRfEdges] = useEdgesState<Edge>([]);
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const [layoutNonce, setLayoutNonce] = useState(0);
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
  const [hoverEdgeId, setHoverEdgeId] = useState<string | null>(null);

  // Refit the view whenever the canvas container resizes — window resizes and,
  // critically, entering/leaving fullscreen (the container size change is what
  // ReactFlow otherwise mis-handles, leaving the graph clipped or off-center).
  const wrapperRef = useRef<HTMLDivElement>(null);
  const rfRef = useRef<ReactFlowInstance<Node<StatusNodeData>, Edge> | null>(null);
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => rfRef.current?.fitView({ padding: 0.2 }));
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  const rank = useMemo(() => statusRankMap(statuses), [statuses]);
  const bundles = useMemo(() => bundleEdges(edges), [edges]);

  // Active focus = clicked node (sticky) or hovered node (transient). Dims
  // everything outside the node's in/out neighborhood.
  const activeFocus = focusNodeId ?? hoverNodeId;
  const focusSet = useMemo(
    () => (activeFocus ? computeFocusSet(activeFocus, edges) : null),
    [activeFocus, edges],
  );

  // ── Nodes: lay out once per node, then keep position; only data changes after. ──
  const nodeSig = useMemo(
    () => JSON.stringify(nodes.map((n) => [n.id, n.label, n.color ?? '', n.terminal, n.orphan, n.missing])),
    [nodes],
  );
  useEffect(() => {
    const layoutPos = layoutGraph(nodes, spineRankEdges(edges, statuses), { direction: 'LR' });
    const ids = new Set(nodes.map((n) => n.id));
    for (const id of positions.current.keys()) {
      if (!ids.has(id)) positions.current.delete(id);
    }
    setRfNodes(
      nodes.map((n) => {
        let pos = positions.current.get(n.id);
        if (!pos) {
          pos = layoutPos.get(n.id) ?? { x: 0, y: 0 };
          positions.current.set(n.id, pos);
        }
        return {
          id: n.id,
          type: 'status',
          position: pos,
          data: {
            label: n.label,
            statusId: n.id,
            color: n.color,
            terminal: n.terminal,
            orphan: n.orphan,
            missing: n.missing,
            dimmed: false,
          },
          draggable: true,
          deletable: false,
        };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeSig, layoutNonce, setRfNodes]);

  // Update node dimming when the focus set changes (no reposition).
  useEffect(() => {
    setRfNodes((prev) =>
      prev.map((n) => {
        const dimmed = focusSet ? !focusSet.nodeIds.has(n.id) : false;
        return n.data.dimmed === dimmed ? n : { ...n, data: { ...n.data, dimmed } };
      }),
    );
  }, [focusSet, setRfNodes]);

  const handleRelayout = useCallback(() => {
    positions.current.clear();
    setLayoutNonce((n) => n + 1);
  }, []);

  const handleSelectCommand = useCallback((rowKey: string) => onSelectEdge(rowKey), [onSelectEdge]);

  // ── Edges: one ReactFlow edge per bundle (status pair). ──
  const edgeSig = useMemo(
    () =>
      bundles
        .map(
          (b) =>
            `${b.from}>${b.to}:${b.commands
              .map((c) => `${c.rowKey}/${c.command}/${c.requiresReason ? 1 : 0}/${c.undefinedRef ? 1 : 0}`)
              .join(',')}`,
        )
        .join('|'),
    [bundles],
  );
  useEffect(() => {
    setRfEdges(
      bundles.map((b) => {
        const id = `${b.from}>${b.to}`;
        const rowKeys = b.commands.map((c) => c.rowKey);
        const undefinedRef = b.commands.some((c) => c.undefinedRef);
        const edgeClass = bundleClass(b.commands, b.from, b.to, rank);
        const selected = selectedRowKey != null && rowKeys.includes(selectedRowKey);
        const inFocus = focusSet ? rowKeys.some((k) => focusSet.edgeKeys.has(k)) : false;
        const dimmed = focusSet ? !inFocus : false;
        const showChips = selected || inFocus || hoverEdgeId === id;
        return {
          id,
          source: b.from,
          target: b.to,
          type: 'transition',
          selected,
          deletable: editable,
          data: {
            from: b.from,
            to: b.to,
            commands: b.commands,
            edgeClass,
            undefinedRef,
            selected,
            dimmed,
            showChips,
            selectedRowKey,
            onSelectCommand: handleSelectCommand,
          } satisfies TransitionEdgeData,
        } satisfies Edge;
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edgeSig, selectedRowKey, focusSet, hoverEdgeId, editable, rank, setRfEdges, handleSelectCommand]);

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
      const rowKeys: string[] = [];
      for (const e of deleted) {
        const cmds = (e.data as TransitionEdgeData).commands;
        // If a single command in this bundle is selected, delete only that one —
        // deleting the whole bundle would silently drop the sibling transitions
        // the user did not select. Otherwise remove the whole (single-command) edge.
        if (selectedRowKey && cmds.some((c) => c.rowKey === selectedRowKey)) {
          rowKeys.push(selectedRowKey);
        } else {
          rowKeys.push(...cmds.map((c) => c.rowKey));
        }
      }
      if (rowKeys.length) onDeleteEdge(rowKeys);
    },
    [editable, onDeleteEdge, selectedRowKey],
  );

  // Clicking the edge path (not a chip) selects the bundle's first command.
  const handleEdgeClick = useCallback(
    (_: unknown, edge: Edge) => {
      const first = (edge.data as TransitionEdgeData).commands[0];
      if (first) onSelectEdge(first.rowKey);
    },
    [onSelectEdge],
  );

  // Keyboard selection (focus an edge + Enter/Space) flows through ReactFlow's
  // selection change, not onEdgeClick — sync it so keyboard users reach the
  // inspector/chips. Only act on a single-edge selection.
  const handleSelectionChange = useCallback(
    ({ edges: selectedEdges }: { edges: Edge[] }) => {
      if (selectedEdges.length !== 1) return;
      const cmds = (selectedEdges[0].data as TransitionEdgeData).commands;
      // Keep an already-selected command within this bundle (e.g. a chip click,
      // which marks the whole bundle ReactFlow-selected) instead of snapping back
      // to commands[0]. Only adopt the first command for a fresh keyboard
      // selection of an edge whose commands aren't the current selection.
      if (selectedRowKey && cmds.some((c) => c.rowKey === selectedRowKey)) return;
      const first = cmds[0];
      if (first) onSelectEdge(first.rowKey);
    },
    [onSelectEdge, selectedRowKey],
  );

  const handleNodeClick = useCallback(
    (_: unknown, node: Node) => onFocusNode(focusNodeId === node.id ? null : node.id),
    [focusNodeId, onFocusNode],
  );

  const handlePaneClick = useCallback(() => onFocusNode(null), [onFocusNode]);

  return (
    <div
      ref={wrapperRef}
      className="relative h-full min-h-[420px] w-full overflow-hidden rounded-md border border-border/60 bg-background"
    >
      <ArrowMarkers />
      <ReactFlow
        onInit={(inst) => {
          rfRef.current = inst;
        }}
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={handleNodesChange}
        onConnect={handleConnect}
        onEdgesDelete={handleEdgesDelete}
        onEdgeClick={handleEdgeClick}
        onSelectionChange={handleSelectionChange}
        onEdgeMouseEnter={(_, e) => setHoverEdgeId(e.id)}
        onEdgeMouseLeave={() => setHoverEdgeId(null)}
        onNodeClick={handleNodeClick}
        onNodeMouseEnter={(_, n) => setHoverNodeId(n.id)}
        onNodeMouseLeave={() => setHoverNodeId(null)}
        onPaneClick={handlePaneClick}
        nodesConnectable={editable}
        deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: false }}
      >
        <Background gap={16} />
        <Controls showInteractive={false} />
        <RelayoutPanel onRelayout={handleRelayout} />
      </ReactFlow>
    </div>
  );
}
