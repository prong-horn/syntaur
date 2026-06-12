import type { ReactNode } from 'react';
import { createElement } from 'react';
import { Activity, Boxes, LayoutTemplate, type LucideIcon } from 'lucide-react';
import type { WidgetConfig } from '@shared/saved-views-schema';
import { SavedViewWidget } from './widgets/SavedViewWidget';
import { AgentSessionsWidget } from './widgets/AgentSessionsWidget';
import { InventoriesWidget } from './widgets/InventoriesWidget';

export interface WidgetRendererCtx {
  slotId: string;
  onPickAnother: () => void;
}

export interface WidgetRenderer {
  title: string;
  icon: LucideIcon;
  render: (config: WidgetConfig, ctx: WidgetRendererCtx) => ReactNode;
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
};
