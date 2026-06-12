import { useState } from 'react';
import { Plus, Trash2, Replace, Maximize2, Settings2 } from 'lucide-react';
import type { DashboardSlot, WidgetConfig, WidgetSize } from '@shared/saved-views-schema';
import { WIDGET_SIZES } from '@shared/saved-views-schema';
import { cn } from '../../lib/utils';
import { useSavedView } from '../../hooks/useSavedViews';
import { OverflowMenu } from '../OverflowMenu';
import { widgetRegistry } from './widgetRegistry';

interface WidgetSlotProps {
  slot: DashboardSlot;
  index: number;
  onReplace: () => void;
  onRemove: () => void;
  onResize: (size: WidgetSize) => void;
  /** Persist an edited config for this slot's widget. Rejects on failure so the editor can stay open. */
  onConfigChange: (next: WidgetConfig) => Promise<void>;
}

// Size → Tailwind classes. These MUST be literal full class strings (no string
// interpolation) and live under `dashboard/src/` so Tailwind's content scan
// (which only covers `dashboard/`) keeps them in the production build. Width
// spans 2 columns at the `xl` breakpoint (the grid is single-column below
// `xl`, so `xl:col-span-2` is a no-op there); height is a `min-h` tier rather
// than a grid row-span so neighbouring slots stay predictable.
const SIZE_CLASS: Record<WidgetSize, string> = {
  small: 'min-h-[320px]',
  wide: 'xl:col-span-2 min-h-[320px]',
  tall: 'min-h-[560px]',
  large: 'xl:col-span-2 min-h-[560px]',
};

const SIZE_LABEL: Record<WidgetSize, string> = {
  small: 'Small',
  wide: 'Wide',
  tall: 'Tall',
  large: 'Large',
};

export function WidgetSlot({ slot, onReplace, onRemove, onResize, onConfigChange }: WidgetSlotProps) {
  const [configuring, setConfiguring] = useState(false);
  // Absent `size` defaults to `small` (backward compatibility). The same
  // default feeds the submenu `active` check below so the checkmark and the
  // rendered size can never disagree.
  const size = slot.size ?? 'small';
  const sizeClass = SIZE_CLASS[size];

  if (slot.widget === null) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-lg border border-dashed border-border/60 bg-card/40 p-3 shadow-sm',
          sizeClass,
        )}
      >
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
        className={cn(
          'overflow-auto rounded-lg border border-border/60 bg-card/85 p-3 shadow-sm',
          sizeClass,
        )}
      >
        <div className="rounded-md border border-border/60 bg-background/60 px-3 py-2 text-sm text-muted-foreground">
          Unknown widget kind: {slot.widget.kind}
        </div>
      </div>
    );
  }

  const Icon = renderer.icon;
  const ConfigEditor = renderer.ConfigEditor;

  return (
    <div
      className={cn(
        'overflow-auto rounded-lg border border-border/60 bg-card/85 p-3 shadow-sm',
        sizeClass,
      )}
    >
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
              submenu: WIDGET_SIZES.map((s) => ({
                key: `size-${s}`,
                label: SIZE_LABEL[s],
                active: s === size,
                onSelect: () => onResize(s),
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
