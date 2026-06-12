import { useMemo, useState, useRef, useEffect } from 'react';
import { Check, ChevronDown, Plus } from 'lucide-react';
import { useSavedViews } from '../hooks/useSavedViews';
import { cn } from '../lib/utils';

interface SessionViewPickerProps {
  activeViewId: string | null;
  onSelectView: (viewId: string | null) => void;
  onCreateNew: () => void;
}

export function SessionViewPicker({
  activeViewId,
  onSelectView,
  onCreateNew,
}: SessionViewPickerProps) {
  const { views, loading } = useSavedViews();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const sessionViews = useMemo(
    () => views.filter((v) => v.entityType === 'session'),
    [views],
  );

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

  const activeView = activeViewId ? views.find((v) => v.id === activeViewId) ?? null : null;
  const triggerLabel = loading
    ? 'Session views…'
    : activeView
      ? activeView.name
      : 'Session views';

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={loading}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-background disabled:opacity-50"
        aria-haspopup="true"
        aria-expanded={open}
        title="Session views"
      >
        <span className="max-w-[160px] truncate">{triggerLabel}</span>
        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 min-w-[240px] rounded-md border border-border/70 bg-background shadow-lg py-1">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onSelectView(null);
            }}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:bg-foreground/5',
              !activeViewId && 'font-semibold text-foreground',
            )}
          >
            <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
              {!activeViewId ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
            </span>
            <span>All sessions</span>
          </button>

          {sessionViews.length > 0 && (
            <>
              <div className="my-1 border-t border-border/40" />
              {sessionViews.map((view) => {
                const selected = view.id === activeViewId;
                return (
                  <button
                    key={view.id}
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onSelectView(view.id);
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
              })}
            </>
          )}

          <div className="my-1 border-t border-border/40" />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onCreateNew();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:bg-foreground/5 text-muted-foreground"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>Create new view…</span>
          </button>
        </div>
      )}
    </div>
  );
}
