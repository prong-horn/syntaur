import { Plus, Trash2, Replace } from 'lucide-react';
import type { DashboardSlot } from '@shared/saved-views-schema';
import { useSavedView } from '../../hooks/useSavedViews';
import { OverflowMenu } from '../OverflowMenu';
import { widgetRegistry } from './widgetRegistry';

interface WidgetSlotProps {
  slot: DashboardSlot;
  index: number;
  onReplace: () => void;
  onRemove: () => void;
}

export function WidgetSlot({ slot, onReplace, onRemove }: WidgetSlotProps) {
  if (slot.widget === null) {
    return (
      <div className="flex min-h-[320px] items-center justify-center rounded-lg border border-dashed border-border/60 bg-card/40 p-3 shadow-sm">
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
      <div className="min-h-[320px] overflow-auto rounded-lg border border-border/60 bg-card/85 p-3 shadow-sm">
        <div className="rounded-md border border-border/60 bg-background/60 px-3 py-2 text-sm text-muted-foreground">
          Unknown widget kind: {slot.widget.kind}
        </div>
      </div>
    );
  }

  const Icon = renderer.icon;

  return (
    <div className="min-h-[320px] overflow-auto rounded-lg border border-border/60 bg-card/85 p-3 shadow-sm">
      <header className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs uppercase tracking-[0.12em] text-muted-foreground">
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="truncate">
            <WidgetTitle slot={slot} fallback={renderer.title} />
          </span>
        </div>
        <OverflowMenu
          items={[
            { key: 'replace', label: 'Replace…', icon: Replace, onSelect: onReplace },
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
