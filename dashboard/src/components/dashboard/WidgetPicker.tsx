import { Link } from 'react-router-dom';
import type { WidgetConfig, WidgetKind } from '@shared/saved-views-schema';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog';
import { useSavedViews } from '../../hooks/useSavedViews';
import { widgetRegistry } from './widgetRegistry';

interface WidgetPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (config: WidgetConfig) => void;
}

// Built-in widget kinds (everything in the registry except `saved-view`,
// which is selected via the Saved Views section).
const BUILT_IN_KINDS: ReadonlyArray<Exclude<WidgetKind, 'saved-view'>> = [
  'agent-sessions',
  'inventories',
];

export function WidgetPicker({ open, onOpenChange, onSelect }: WidgetPickerProps) {
  const { views, loading } = useSavedViews();

  function pick(config: WidgetConfig) {
    onSelect(config);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a widget</DialogTitle>
          <DialogDescription>
            Choose a built-in widget or one of your saved views.
          </DialogDescription>
        </DialogHeader>

        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Built-in widgets
          </h3>
          <ul className="divide-y divide-border/40 rounded-md border border-border/60">
            {BUILT_IN_KINDS.map((kind) => {
              const renderer = widgetRegistry[kind];
              const Icon = renderer.icon;
              return (
                <li key={kind}>
                  <button
                    type="button"
                    onClick={() => pick({ kind } as WidgetConfig)}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-muted/40"
                  >
                    <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    <span className="font-medium text-foreground">{renderer.title}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Saved views
          </h3>
          {loading ? (
            <div className="rounded-md border border-border/60 px-3 py-4 text-sm text-muted-foreground">
              Loading saved views…
            </div>
          ) : views.length === 0 ? (
            <div className="rounded-md border border-border/60 px-3 py-4 text-sm">
              <p className="font-medium text-foreground">No saved views yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Save a view from the assignments page first.{' '}
                <Link to="/views" className="text-foreground underline hover:opacity-80">
                  Manage views →
                </Link>
              </p>
            </div>
          ) : (
            <ul className="max-h-72 divide-y divide-border/40 overflow-auto rounded-md border border-border/60">
              {views.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    onClick={() => pick({ kind: 'saved-view', viewId: v.id })}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-muted/40"
                  >
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                      {v.name}
                    </span>
                    {v.workspace !== null ? (
                      <span
                        className="shrink-0 rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground"
                        title={`Scoped to workspace: ${v.workspace}`}
                      >
                        {v.workspace}
                      </span>
                    ) : null}
                    <span className="shrink-0 rounded-full border border-border/60 px-2 py-0.5 text-[10px] capitalize text-muted-foreground">
                      {v.config.viewMode}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!loading && views.some((v) => v.workspace !== null) ? (
            <p className="text-[11px] text-muted-foreground">
              Workspace-scoped views on the global Overview will only show items from that workspace.
            </p>
          ) : null}
        </section>
      </DialogContent>
    </Dialog>
  );
}
