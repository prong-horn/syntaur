import { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Plus, Trash2, Replace, Maximize2, Settings2 } from 'lucide-react';
import type { DashboardSlot, WidgetConfig, WidgetGeometry, WidgetSize } from '@shared/saved-views-schema';
import { cn } from '../../lib/utils';
import { useSavedView } from '../../hooks/useSavedViews';
import { OverflowMenu } from '../OverflowMenu';
import { widgetRegistry } from './widgetRegistry';
import { resolveGeometry, scaleSpan, SIZE_PRESETS } from '../../pages/overview-geometry';

interface WidgetSlotProps {
  slot: DashboardSlot;
  index: number;
  activeColumns: number;
  colWidthPx: number;
  onReplace: () => void;
  onRemove: () => void;
  onResize: (size: WidgetSize | WidgetGeometry) => void;
  /** Persist an edited config for this slot's widget. Rejects on failure so the editor can stay open. */
  onConfigChange: (next: WidgetConfig) => Promise<void>;
}

export function WidgetSlot({ slot, activeColumns, onReplace, onRemove, onResize, onConfigChange }: WidgetSlotProps) {
  const [configuring, setConfiguring] = useState(false);
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
  const renderW = scaleSpan(geom.w, activeColumns);

  const style = {
    // Preserve intrinsic widget dimensions when sorting between differently
    // sized grid cells; dnd-kit's scale terms visibly squash wide/tall cards.
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    position: isDragging ? ('relative' as const) : undefined,
    gridColumn: `span ${renderW}`,
    gridRow: `span ${geom.h}`,
  };

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
    return (
      <div
        ref={setNodeRef}
        style={style}
        className={cn(
          'relative flex items-center justify-center rounded-lg border border-dashed border-border/60 bg-card/40 p-3 shadow-sm',
          isDragging && 'opacity-0',
        )}
      >
        <div className="absolute left-2 top-2">{dragHandle}</div>
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
          'overflow-auto rounded-lg border border-border/60 bg-card/85 p-3 shadow-sm',
          isDragging && 'opacity-0',
        )}
      >
        <div className="flex items-start gap-2">
          {dragHandle}
          <div className="flex-1 rounded-md border border-border/60 bg-background/60 px-3 py-2 text-sm text-muted-foreground">
            Unknown widget kind: {slot.widget.kind}
          </div>
        </div>
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
        'overflow-auto rounded-lg border border-border/60 bg-card/85 p-3 shadow-sm',
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
    </div>
  );
}

export function WidgetDragPreview({ slot }: { slot: DashboardSlot }) {
  const renderer = slot.widget ? widgetRegistry[slot.widget.kind] : null;
  const Icon = renderer?.icon;
  const title =
    slot.widget === null
      ? 'Empty widget slot'
      : renderer?.title ?? `Unknown widget kind: ${slot.widget.kind}`;

  return (
    <div
      aria-hidden="true"
      className="w-72 rounded-lg border border-border/70 bg-card/95 p-3 shadow-xl ring-1 ring-foreground/10"
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
