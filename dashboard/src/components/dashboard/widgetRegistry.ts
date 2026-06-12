import type { ComponentType, ReactNode } from 'react';
import { createElement } from 'react';
import { Activity, Boxes, Coins, Hash, LayoutTemplate, type LucideIcon } from 'lucide-react';
import type { WidgetConfig } from '@shared/saved-views-schema';
import { SavedViewWidget } from './widgets/SavedViewWidget';
import { AgentSessionsWidget } from './widgets/AgentSessionsWidget';
import { InventoriesWidget } from './widgets/InventoriesWidget';
import { UsageWidget } from './widgets/UsageWidget';
import { UsageWidgetConfigDialog } from './widgets/UsageWidgetConfigDialog';

export interface WidgetRendererCtx {
  slotId: string;
  onPickAnother: () => void;
}

/**
 * Optional per-widget configuration editor. When a renderer defines this,
 * `WidgetSlot` shows a "Configure…" menu item that mounts the editor. `onSave`
 * is async (it persists the dashboard layout) and may reject — the editor keeps
 * itself open and shows the error in that case. This keeps `WidgetSlot` generic:
 * it never imports a widget-specific dialog.
 */
export type WidgetConfigEditor = ComponentType<{
  config: WidgetConfig;
  open: boolean;
  onSave: (next: WidgetConfig) => Promise<void>;
  onCancel: () => void;
}>;

export interface WidgetRenderer {
  title: string;
  icon: LucideIcon;
  render: (config: WidgetConfig, ctx: WidgetRendererCtx) => ReactNode;
  ConfigEditor?: WidgetConfigEditor;
}

export const widgetRegistry: Record<WidgetConfig['kind'], WidgetRenderer> = {
  'saved-view': {
    title: 'Saved view',
    icon: LayoutTemplate,
    render: (config, ctx) => {
      // Narrow the union to the saved-view variant.
      if (config.kind !== 'saved-view') return null;
      return createElement(SavedViewWidget, {
        viewId: config.viewId,
        onPickAnother: ctx.onPickAnother,
      });
    },
  },
  'agent-sessions': {
    title: 'Agent sessions',
    icon: Activity,
    render: (config, ctx) => {
      if (config.kind !== 'agent-sessions') return null;
      return createElement(AgentSessionsWidget, {
        viewId: config.viewId,
        slotId: ctx.slotId,
        onPickAnother: ctx.onPickAnother,
      });
    },
  },
  inventories: {
    title: 'Inventories',
    icon: Boxes,
    render: () => createElement(InventoriesWidget),
  },
  'token-usage': {
    title: 'Token Usage',
    icon: Hash,
    render: (config) => {
      if (config.kind !== 'token-usage') return null;
      return createElement(UsageWidget, { filters: config.filters, metric: 'tokens' });
    },
    ConfigEditor: UsageWidgetConfigDialog,
  },
  spend: {
    title: 'Spend',
    icon: Coins,
    render: (config) => {
      if (config.kind !== 'spend') return null;
      return createElement(UsageWidget, { filters: config.filters, metric: 'cost' });
    },
    ConfigEditor: UsageWidgetConfigDialog,
  },
};
