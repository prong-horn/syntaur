import { useCallback, useState } from 'react';
import { Monitor } from 'lucide-react';
import { useHelp, useOverview } from '../hooks/useProjects';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { GettingStartedCard } from '../components/GettingStartedCard';
import { OverviewHero } from '../components/OverviewHero';
import { WidgetSlot } from '../components/dashboard/WidgetSlot';
import { WidgetPicker } from '../components/dashboard/WidgetPicker';
import {
  useDashboardLayout,
  setDashboardLayout,
} from '../hooks/useSavedViews';
import { useHotkey, useHotkeyScope } from '../hotkeys';
import type { DashboardSlot, WidgetConfig } from '@shared/saved-views-schema';

export function Overview() {
  const { data: overview, error, refetch } = useOverview();
  const { data: help } = useHelp();
  const { layout } = useDashboardLayout();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSlotIndex, setPickerSlotIndex] = useState<number | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);

  useHotkeyScope('list:overview');
  useHotkey({
    keys: 'r',
    description: 'Refresh',
    scope: 'list:overview',
    handler: () => {
      void refetch();
    },
  });

  const openPicker = useCallback((index: number) => {
    setPickerSlotIndex(index);
    setPickerOpen(true);
  }, []);

  const persistLayout = useCallback(async (nextSlots: DashboardSlot[]) => {
    setLayoutError(null);
    try {
      await setDashboardLayout(nextSlots);
    } catch (err) {
      setLayoutError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handlePick = useCallback(
    (config: WidgetConfig) => {
      if (pickerSlotIndex === null) return;
      const nextSlots = layout.slots.map((slot, i) =>
        i === pickerSlotIndex ? { ...slot, widget: config } : slot,
      );
      setPickerSlotIndex(null);
      void persistLayout(nextSlots);
    },
    [layout.slots, pickerSlotIndex, persistLayout],
  );

  const handleRemove = useCallback(
    (index: number) => {
      const nextSlots = layout.slots.map((slot, i) =>
        i === index ? { ...slot, widget: null } : slot,
      );
      void persistLayout(nextSlots);
    },
    [layout.slots, persistLayout],
  );

  // Build itemsById from the (still-served-by-the-API) segment payloads so
  // OverviewHero can resolve its `hero.itemId` reference. Segments are not
  // rendered as widgets anymore, but the hero remains coupled to them.
  const itemsById: Record<string, import('../hooks/useProjects').AttentionItem> = {};
  if (overview) {
    for (const key of Object.keys(overview.segments) as Array<keyof typeof overview.segments>) {
      for (const item of overview.segments[key].items) {
        itemsById[item.id] = item;
      }
    }
  }

  // Render the shell (header + dashboard widget grid) immediately rather than
  // blocking the whole page on /api/overview. The widget slots fetch their own
  // data, so they hydrate independently; only the hero, getting-started card,
  // and server-stats footer depend on the overview payload and hydrate when it
  // arrives. This keeps the page from going blank on every load, especially
  // when a background refresh is slow on the work machine.
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="eyebrow">Workspace Overview</p>
        <h1 className="text-4xl font-semibold tracking-display text-foreground md:text-5xl">
          What needs you today
        </h1>
      </header>

      {overview ? (
        <OverviewHero hero={overview.hero} itemsById={itemsById} />
      ) : error ? (
        <ErrorState error={error} />
      ) : (
        <LoadingState label="Loading overview…" />
      )}

      {overview?.firstRun ? <GettingStartedCard help={help} /> : null}

      {layoutError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          Couldn't save dashboard layout: {layoutError}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {layout.slots.map((slot, i) => (
          <WidgetSlot
            key={slot.id}
            slot={slot}
            index={i}
            onReplace={() => openPicker(i)}
            onRemove={() => handleRemove(i)}
          />
        ))}
      </div>

      {overview?.serverStats ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Monitor className="h-3 w-3" aria-hidden="true" />
          <span>
            ● {overview.serverStats.totalPorts} ports ·{' '}
            {overview.serverStats.deadSessions > 0
              ? `${overview.serverStats.deadSessions} dead`
              : 'all healthy'}
          </span>
        </p>
      ) : null}

      <WidgetPicker
        open={pickerOpen}
        onOpenChange={(open) => {
          setPickerOpen(open);
          if (!open) setPickerSlotIndex(null);
        }}
        onSelect={handlePick}
      />
    </div>
  );
}
