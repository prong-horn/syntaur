import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import {
  DATE_RANGE_PRESETS,
  type DateRangeField,
  type DateRangePreset,
} from '@shared/view-prefs-schema';
import type { DateRangeUiState } from '../../lib/savedViews';
import { cn } from '../../lib/utils';

const PRESET_LABEL: Record<DateRangePreset, string> = {
  last_24h: 'Last 24 hours',
  last_7d: 'Last 7 days',
  last_30d: 'Last 30 days',
  last_90d: 'Last 90 days',
  older_7d: 'Older than 7 days',
  older_30d: 'Older than 30 days',
};

interface DateRangeControlProps {
  /** `null` = no date filter. */
  value: DateRangeUiState | null;
  onChange: (v: DateRangeUiState | null) => void;
  className?: string;
  ariaLabel?: string;
}

const FIELDS: DateRangeField[] = ['updated', 'created'];

/**
 * Date-range filter popover. Pick the field (Updated/Created) and either a
 * relative preset (resolved against "now") or an absolute from/to range.
 * Emits `null` when no constraint is active.
 */
export function DateRangeControl({
  value,
  onChange,
  className,
  ariaLabel = 'Date range filter',
}: DateRangeControlProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const field: DateRangeField = value?.field ?? 'updated';
  const isCustom = !!(value && !value.preset && (value.from || value.to));
  const [customMode, setCustomMode] = useState(isCustom);
  useEffect(() => setCustomMode(isCustom), [isCustom]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const active = !!(value && (value.preset || value.from || value.to));

  const summary = useMemo(() => {
    if (!active || !value) return 'Any date';
    if (value.preset) return `${field}: ${PRESET_LABEL[value.preset as DateRangePreset] ?? value.preset}`;
    return `${field}: ${value.from || '…'} → ${value.to || '…'}`;
  }, [active, value, field]);

  function setField(f: DateRangeField) {
    onChange(value ? { ...value, field: f } : { field: f, preset: '', from: '', to: '' });
  }
  function pickPreset(preset: DateRangePreset) {
    setCustomMode(false);
    onChange({ field, preset, from: '', to: '' });
  }
  function pickAny() {
    setCustomMode(false);
    onChange(null);
  }
  function setCustom(part: 'from' | 'to', v: string) {
    const base: DateRangeUiState = { field, preset: '', from: value?.from ?? '', to: value?.to ?? '' };
    onChange({ ...base, [part]: v });
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'editor-input inline-flex items-center justify-between gap-1.5 text-left',
          active && 'border-foreground/40 text-foreground',
          className,
        )}
      >
        <span className="truncate">{summary}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-30 mt-1 w-64 rounded-md border border-border/70 bg-background p-2 shadow-lg">
          <div className="mb-2 inline-flex rounded-md border border-border/60 bg-background/80 p-0.5">
            {FIELDS.map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={field === f}
                onClick={() => setField(f)}
                className={cn(
                  'rounded-sm px-2.5 py-1 text-xs font-medium capitalize transition',
                  field === f ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {f}
              </button>
            ))}
          </div>
          <div className="space-y-0.5">
            <PresetRow label="Any date" selected={!active} onClick={pickAny} />
            {DATE_RANGE_PRESETS.map((p) => (
              <PresetRow
                key={p}
                label={PRESET_LABEL[p]}
                selected={value?.preset === p}
                onClick={() => pickPreset(p)}
              />
            ))}
            <PresetRow
              label="Custom range…"
              selected={customMode}
              onClick={() => {
                // Clear any active preset immediately so Save can't persist a
                // stale preset while the UI shows custom mode.
                setCustomMode(true);
                onChange({ field, preset: '', from: value?.from ?? '', to: value?.to ?? '' });
              }}
            />
          </div>
          {customMode ? (
            <div className="mt-2 space-y-1.5 border-t border-border/60 pt-2">
              <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                From
                <input
                  type="date"
                  value={value?.from ?? ''}
                  max={value?.to || undefined}
                  onChange={(e) => setCustom('from', e.target.value)}
                  className="editor-input w-40"
                />
              </label>
              <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                To
                <input
                  type="date"
                  value={value?.to ?? ''}
                  min={value?.from || undefined}
                  onChange={(e) => setCustom('to', e.target.value)}
                  className="editor-input w-40"
                />
              </label>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PresetRow({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm transition hover:bg-foreground/5',
        selected ? 'text-foreground' : 'text-muted-foreground',
      )}
    >
      <span>{label}</span>
      {selected ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
    </button>
  );
}
