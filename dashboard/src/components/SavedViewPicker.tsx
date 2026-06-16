import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { scopeMatches, type SavedView, type ViewScope } from '@shared/saved-views-schema';
import { useSavedViews } from '../hooks/useSavedViews';
import { cn } from '../lib/utils';

interface SavedViewPickerProps {
  scope: ViewScope;
  loadedViewId: string | null;
  onApply: (view: SavedView) => void;
  onOpenSaveDialog: () => void;
}

export function SavedViewPicker({
  scope,
  loadedViewId,
  onApply,
  onOpenSaveDialog,
}: SavedViewPickerProps) {
  const { views, loading } = useSavedViews();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Click-outside + Escape to close (mirrors OverflowMenu pattern).
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const visibleViews = useMemo(
    () => views.filter((v) => scopeMatches(v, scope)),
    [views, scope],
  );

  const loadedView = loadedViewId ? views.find((v) => v.id === loadedViewId) ?? null : null;
  const triggerLabel = loading
    ? 'Saved views…'
    : loadedView
      ? loadedView.name
      : 'Saved views';

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={loading}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-background disabled:opacity-50"
        aria-haspopup="true"
        aria-expanded={open}
        title={triggerLabel}
      >
        <span className="max-w-[160px] truncate">{triggerLabel}</span>
        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 min-w-[240px] rounded-md border border-border/70 bg-background shadow-lg py-1">
          {visibleViews.length === 0 ? (
            <div className="px-3 py-3 text-sm text-muted-foreground">
              <p className="mb-2">No saved views yet — Save the current view to start.</p>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onOpenSaveDialog();
                }}
                className="shell-action w-full justify-center"
              >
                Save current view
              </button>
            </div>
          ) : (
            visibleViews.map((view) => {
              const selected = view.id === loadedViewId;
              return (
                <button
                  key={view.id}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onApply(view);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:bg-foreground/5',
                    selected && 'font-semibold text-foreground',
                  )}
                >
                  <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
                    {selected ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                  </span>
                  <span className="truncate">{view.name}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
