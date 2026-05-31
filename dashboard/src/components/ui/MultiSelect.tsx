import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface MultiSelectOption {
  value: string;
  label: string;
}

// Friendly labels for known sentinels when they appear as orphan selections
// (a saved value not present in the live option list).
const SENTINEL_LABELS: Record<string, string> = {
  __unassigned__: 'Unassigned',
  __standalone__: 'No project',
};

interface MultiSelectProps {
  options: MultiSelectOption[];
  /** Selected values ([] === none selected === "all"). */
  value: string[];
  onChange: (next: string[]) => void;
  /** Trigger text when nothing is selected, e.g. "All statuses". */
  allLabel?: string;
  /** Extra classes for the trigger button (callers match their filter-bar sizing). */
  className?: string;
  disabled?: boolean;
  /** Accessible name for the trigger + menu. */
  ariaLabel?: string;
}

/**
 * Accessible multi-select rendered as a checkbox menu. Menu container is
 * `role="menu"`; rows are `role="menuitemcheckbox"` with `aria-checked`. Roving
 * focus via Arrow keys, Home/End; Enter/Space toggles; Escape closes and returns
 * focus to the trigger. Any selected value not present in `options` is shown as
 * an extra (orphan) row so an applied saved selection always renders and can be
 * removed.
 */
export function MultiSelect({
  options,
  value,
  onChange,
  allLabel = 'Any',
  className,
  disabled,
  ariaLabel,
}: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Append any selected orphan (not in options) so it stays visible/removable.
  // Known sentinels still get a friendly label even when orphaned.
  const displayOptions = useMemo<MultiSelectOption[]>(() => {
    const known = new Set(options.map((o) => o.value));
    const orphans = value
      .filter((v) => !known.has(v))
      .map((v) => ({ value: v, label: SENTINEL_LABELS[v] ?? v }));
    return [...options, ...orphans];
  }, [options, value]);

  const selected = useMemo(() => new Set(value), [value]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Move focus INTO the menu when it opens so it is keyboard-operable (arrows
  // navigate, Space/Enter toggles, Escape closes). Programmatic focus works on
  // the tabIndex={-1} rows (roving focus). Refs are assigned during commit,
  // before this effect runs.
  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  const summary = useMemo(() => {
    if (value.length === 0) return allLabel;
    if (value.length === 1) {
      const opt = displayOptions.find((o) => o.value === value[0]);
      return opt ? opt.label : value[0];
    }
    return `${value.length} selected`;
  }, [value, displayOptions, allLabel]);

  function toggle(v: string) {
    onChange(selected.has(v) ? value.filter((x) => x !== v) : [...value, v]);
  }

  function focusItem(index: number) {
    const clamped = Math.max(0, Math.min(index, displayOptions.length - 1));
    itemRefs.current[clamped]?.focus();
  }

  function onMenuKeyDown(e: React.KeyboardEvent) {
    const items = itemRefs.current;
    const active = document.activeElement;
    const current = items.findIndex((el) => el === active);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusItem(current < 0 ? 0 : current + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusItem(current < 0 ? displayOptions.length - 1 : current - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusItem(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusItem(displayOptions.length - 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={cn(
          'editor-input inline-flex items-center justify-between gap-1.5 text-left',
          value.length > 0 && 'border-foreground/40 text-foreground',
          className,
        )}
      >
        <span className="truncate">{summary}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={ariaLabel}
          onKeyDown={onMenuKeyDown}
          className="absolute left-0 top-full z-30 mt-1 max-h-72 min-w-[200px] overflow-auto rounded-md border border-border/70 bg-background py-1 shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 px-2 pb-1">
            <button
              type="button"
              role="menuitem"
              className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
              disabled={value.length === displayOptions.length}
              onClick={() => onChange(displayOptions.map((o) => o.value))}
            >
              Select all
            </button>
            <button
              type="button"
              role="menuitem"
              className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
              disabled={value.length === 0}
              onClick={() => onChange([])}
            >
              Clear
            </button>
          </div>
          {displayOptions.length === 0 ? (
            <p className="px-3 py-1.5 text-xs text-muted-foreground">No options</p>
          ) : (
            displayOptions.map((opt, i) => {
              const isOn = selected.has(opt.value);
              return (
                <button
                  key={opt.value}
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={isOn}
                  tabIndex={-1}
                  onClick={() => toggle(opt.value)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:bg-foreground/5',
                    isOn ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                      isOn ? 'border-foreground bg-foreground text-background' : 'border-border/70',
                    )}
                    aria-hidden="true"
                  >
                    {isOn ? <Check className="h-3 w-3" /> : null}
                  </span>
                  <span className="truncate">{opt.label}</span>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
