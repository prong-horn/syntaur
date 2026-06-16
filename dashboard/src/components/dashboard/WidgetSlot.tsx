import { useRef, useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Plus, Trash2, Replace, Maximize2, Settings2 } from 'lucide-react';
import { GRID_COLUMNS } from '@shared/saved-views-schema';
import type { DashboardSlot, WidgetConfig, WidgetGeometry, WidgetSize } from '@shared/saved-views-schema';
import { cn } from '../../lib/utils';
import { useSavedView } from '../../hooks/useSavedViews';
import { OverflowMenu } from '../OverflowMenu';
import { widgetRegistry } from './widgetRegistry';
import {
  clamp,
  EMPTY_SLOT_GEOMETRY,
  GRID_GAP_PX,
  MAX_ROWS,
  MIN_ROWS,
  pxToCols,
  pxToRows,
  resolveGeometry,
  scaleSpan,
  SIZE_PRESETS,
} from '../../pages/overview-geometry';

interface WidgetSlotProps {
  slot: DashboardSlot;
  index: number;
  activeColumns: number;
  colWidthPx: number;
  onReplace: () => void;
  onRemove: () => void;
  onRemoveSlot: () => void;
  onResize: (size: WidgetSize | WidgetGeometry) => void;
  /** Persist an edited config for this slot's widget. Rejects on failure so the editor can stay open. */
  onConfigChange: (next: WidgetConfig) => Promise<void>;
}

export function WidgetSlot({
  slot,
  activeColumns,
  colWidthPx,
  onReplace,
  onRemove,
  onRemoveSlot,
  onResize,
  onConfigChange,
}: WidgetSlotProps) {
  const [configuring, setConfiguring] = useState(false);
  // Live resize preview, tracked in RENDER space (render columns, row units) so
  // we never re-round into stored 24-col space mid-gesture (avoids drift/jitter).
  const [preview, setPreview] = useState<{ renderW: number; h: number } | null>(null);
  // Mutable gesture state. `lastRenderW`/`lastH` mirror the latest preview so
  // onPointerUp can commit from this ref (synchronous) instead of stale React state.
  const gestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startRenderW: number;
    startH: number;
    axis: 'w' | 'h' | 'both';
    lastRenderW: number;
    lastH: number;
  } | null>(null);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: slot.id });

  const geom = resolveGeometry(slot.size);
  // Prefer the live preview while a resize gesture is active so the grid reflows
  // in real time; fall back to the persisted geometry otherwise.
  const effRenderW = preview ? preview.renderW : scaleSpan(geom.w, activeColumns);
  const effRowSpan = preview ? preview.h : geom.h;

  const style = {
    // Preserve intrinsic widget dimensions when sorting between differently
    // sized grid cells; dnd-kit's scale terms visibly squash wide/tall cards.
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    position: isDragging ? ('relative' as const) : undefined,
    gridColumn: `span ${effRenderW}`,
    gridRow: `span ${effRowSpan}`,
  };

  // Shared no-commit teardown for cancel/lost-capture (and the tail of a normal
  // pointerup). DISCARDS any in-progress resize: nulls the gesture, releases
  // capture, and clears the preview so the rendered size snaps back to the
  // persisted `slot.size`. Used by up/cancel/lost-capture so all three paths
  // clear state identically.
  function endGesture(e: React.PointerEvent) {
    gestureRef.current = null;
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    setPreview(null);
  }

  function makeResizeHandlers(axis: 'w' | 'h' | 'both') {
    return {
      onPointerDown: (e: React.PointerEvent) => {
        // Single-pointer: ignore a secondary pointer while a gesture is active so
        // a second touch/pen can't hijack or restart the in-progress resize.
        if (gestureRef.current) return;
        e.preventDefault();
        e.stopPropagation(); // never let a handle drag start a dnd sort
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        const startRenderW = scaleSpan(geom.w, activeColumns);
        gestureRef.current = {
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          startRenderW,
          startH: geom.h,
          axis,
          lastRenderW: startRenderW,
          lastH: geom.h,
        };
        setPreview({ renderW: startRenderW, h: geom.h });
      },
      onPointerMove: (e: React.PointerEvent) => {
        const g = gestureRef.current;
        if (!g) return;
        // Ignore strays from any pointer other than the one that started the gesture.
        if (e.pointerId !== g.pointerId) return;
        let renderW = g.startRenderW;
        let h = g.startH;
        if (g.axis === 'w' || g.axis === 'both') {
          renderW = clamp(g.startRenderW + pxToCols(e.clientX - g.startX, colWidthPx), 1, activeColumns);
        }
        if (g.axis === 'h' || g.axis === 'both') {
          h = clamp(g.startH + pxToRows(e.clientY - g.startY), MIN_ROWS, MAX_ROWS);
        }
        // Stash the authoritative latest values on the ref so onPointerUp never
        // reads stale React state (setPreview is async/batched).
        g.lastRenderW = renderW;
        g.lastH = h;
        setPreview({ renderW, h });
      },
      onPointerUp: (e: React.PointerEvent) => {
        const g = gestureRef.current;
        if (!g) return;
        // Only the gesture's own pointer may commit/end it.
        if (e.pointerId !== g.pointerId) return;
        // Commit first, from the authoritative ref values, then tear down.
        const current = resolveGeometry(slot.size);
        // Only convert width back to stored 24-col space if this gesture touched
        // the width axis. A height-only gesture (e.g. at 1 column, where render
        // width is always clamped to 1) must preserve the persisted stored width
        // rather than collapsing it through the render→stored round-trip.
        const storedW =
          g.axis === 'h'
            ? current.w
            : clamp(Math.round((g.lastRenderW / activeColumns) * GRID_COLUMNS), 1, GRID_COLUMNS);
        const next: WidgetGeometry = { w: storedW, h: g.lastH };
        // Same teardown as cancel/lost-capture — null ref, release capture, clear preview.
        endGesture(e);
        if (next.w !== current.w || next.h !== current.h) {
          onResize(next); // existing optimistic persist + rollback
        }
      },
      // pointercancel (scroll takeover, palm rejection, context menu, captured
      // element unmounting mid-gesture, etc.) does NOT fire a subsequent
      // pointerup — discard the resize so we don't freeze at the preview span.
      onPointerCancel: (e: React.PointerEvent) => {
        const g = gestureRef.current;
        if (!g) return;
        if (e.pointerId !== g.pointerId) return;
        endGesture(e);
      },
      // Backstop for capture lost for any reason (e.g. element unmount on a
      // slots re-render/reorder) where pointercancel may not fire.
      onLostPointerCapture: (e: React.PointerEvent) => {
        const g = gestureRef.current;
        if (!g) return;
        if (e.pointerId !== g.pointerId) return;
        endGesture(e);
      },
    };
  }

  const resizeHandleClass =
    'absolute z-10 touch-none rounded-sm bg-transparent transition hover:bg-primary/30';
  const resizeHandles = (
    <>
      {activeColumns > 1 ? (
        <div
          aria-hidden="true"
          className={cn(resizeHandleClass, 'right-0 top-0 h-full w-1.5 cursor-ew-resize')}
          {...makeResizeHandlers('w')}
        />
      ) : null}
      <div
        aria-hidden="true"
        className={cn(resizeHandleClass, 'bottom-0 left-0 h-1.5 w-full cursor-ns-resize')}
        {...makeResizeHandlers('h')}
      />
      {activeColumns > 1 ? (
        <div
          aria-hidden="true"
          className={cn(resizeHandleClass, 'bottom-0 right-0 h-3 w-3 cursor-nwse-resize')}
          {...makeResizeHandlers('both')}
        />
      ) : null}
    </>
  );

  const dragHandle = (
    <button
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      type="button"
      aria-label="Drag to reorder widget"
      className="touch-none cursor-grab text-muted-foreground/40 transition hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:cursor-grabbing"
    >
      <GripVertical className="h-4 w-4" aria-hidden="true" />
    </button>
  );

  if (slot.widget === null) {
    // Empty slots render at a fixed COMPACT size (ignoring any stored `slot.size`)
    // so a removed large widget never leaves a giant void. They stay draggable +
    // a valid drop target, but are NOT resizable (size a widget after adding it).
    return (
      <div
        ref={setNodeRef}
        style={{
          ...style,
          gridColumn: `span ${scaleSpan(EMPTY_SLOT_GEOMETRY.w, activeColumns)}`,
          gridRow: `span ${EMPTY_SLOT_GEOMETRY.h}`,
        }}
        className={cn(
          'relative flex items-center justify-center rounded-lg border border-dashed border-border bg-card/40 p-3 shadow-sm transition-colors hover:border-primary/40 hover:bg-card/60',
          isDragging && 'opacity-0',
        )}
      >
        <div className="absolute left-2 top-2">{dragHandle}</div>
        <button
          type="button"
          aria-label="Remove slot"
          onClick={onRemoveSlot}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute right-2 top-2 z-10 text-muted-foreground/50 transition hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onReplace}
          className="shell-action inline-flex items-center gap-2"
        >
          <Plus className="h-4 w-4" />
          Add widget
        </button>
      </div>
    );
  }

  const renderer = widgetRegistry[slot.widget.kind];
  if (!renderer) {
    return (
      <div
        ref={setNodeRef}
        style={style}
        className={cn(
          'relative overflow-auto rounded-lg border border-border/60 bg-card/85 p-3 shadow-sm',
          isDragging && 'opacity-0',
        )}
      >
        <div className="flex items-start gap-2">
          {dragHandle}
          <div className="flex-1 rounded-md border border-border/60 bg-background/60 px-3 py-2 text-sm text-muted-foreground">
            Unknown widget kind: {slot.widget.kind}
          </div>
        </div>
        {resizeHandles}
      </div>
    );
  }

  const Icon = renderer.icon;
  const ConfigEditor = renderer.ConfigEditor;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'relative overflow-auto rounded-lg border border-border/60 bg-card/85 p-3 shadow-sm',
        isDragging && 'opacity-0',
      )}
    >
      <header className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs uppercase tracking-[0.12em] text-muted-foreground">
          {dragHandle}
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="truncate">
            <WidgetTitle slot={slot} fallback={renderer.title} />
          </span>
        </div>
        <OverflowMenu
          items={[
            { key: 'replace', label: 'Replace…', icon: Replace, onSelect: onReplace },
            ...(renderer.ConfigEditor
              ? [
                  {
                    key: 'configure',
                    label: 'Configure…',
                    icon: Settings2,
                    onSelect: () => setConfiguring(true),
                  },
                ]
              : []),
            {
              key: 'size',
              label: 'Size',
              icon: Maximize2,
              submenu: SIZE_PRESETS.map((preset) => ({
                key: `size-${preset.label}`,
                label: preset.label,
                active: geom.w === preset.w && geom.h === preset.h,
                onSelect: () => onResize({ w: preset.w, h: preset.h }),
              })),
            },
            { key: 'remove', label: 'Remove', icon: Trash2, destructive: true, onSelect: onRemove },
          ]}
        />
      </header>
      <div>
        {renderer.render(slot.widget, {
          slotId: slot.id,
          onPickAnother: onReplace,
        })}
      </div>
      {ConfigEditor ? (
        <ConfigEditor
          config={slot.widget}
          open={configuring}
          onSave={async (next) => {
            // Propagate rejection: on failure the editor stays open + shows the
            // error; only close after the layout persists successfully.
            await onConfigChange(next);
            setConfiguring(false);
          }}
          onCancel={() => setConfiguring(false)}
        />
      ) : null}
      {resizeHandles}
    </div>
  );
}

export function WidgetDragPreview({
  slot,
  activeColumns,
  colWidthPx,
}: {
  slot: DashboardSlot;
  activeColumns: number;
  colWidthPx: number;
}) {
  const renderer = slot.widget ? widgetRegistry[slot.widget.kind] : null;
  const Icon = renderer?.icon;
  const title =
    slot.widget === null
      ? 'Empty widget slot'
      : renderer?.title ?? `Unknown widget kind: ${slot.widget.kind}`;

  // Empty slots ghost at the compact size they actually render at (not any stored size).
  const geom = slot.widget === null ? EMPTY_SLOT_GEOMETRY : resolveGeometry(slot.size);
  const renderW = scaleSpan(geom.w, activeColumns);
  const widthPx =
    colWidthPx > 0 ? renderW * colWidthPx + (renderW - 1) * GRID_GAP_PX : undefined;

  return (
    <div
      aria-hidden="true"
      className="min-w-[200px] rounded-lg border border-border/70 bg-card/95 p-3 shadow-xl ring-1 ring-foreground/10"
      style={{ width: widthPx ? `${Math.max(widthPx, 200)}px` : undefined }}
    >
      <div className="flex items-center gap-2 text-xs uppercase tracking-[0.12em] text-muted-foreground">
        <GripVertical className="h-4 w-4" aria-hidden="true" />
        {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden="true" /> : null}
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </div>
    </div>
  );
}

/**
 * For `saved-view` widgets, show the view's name instead of the generic
 * "Saved view" label so users can distinguish slots at a glance. Falls back
 * to the renderer title for built-in widgets or while the view is loading.
 */
function WidgetTitle({ slot, fallback }: { slot: DashboardSlot; fallback: string }) {
  // Always call the hook (with a possibly-null id) so call order is stable
  // regardless of widget kind.
  const id = slot.widget?.kind === 'saved-view' ? slot.widget.viewId : null;
  const { view } = useSavedView(id);
  if (slot.widget?.kind === 'saved-view' && view) {
    return <>{view.name}</>;
  }
  return <>{fallback}</>;
}
