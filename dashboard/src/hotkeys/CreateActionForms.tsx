import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import type {
  FlowOption,
  PickerFlowStep,
  TextFlowStep,
} from './actionsIndex';
import { rankAll } from './fuzzy';

interface StepHeaderProps {
  /** Visible label rendered above the step body. */
  label: string;
  /**
   * Called when the user clicks the visible Back button or presses Esc on the
   * first step. The palette dialog handles Esc internally; this is just the
   * click handler.
   */
  onBack: () => void;
  /** Disable Back while the flow is mid-submit. */
  disabled?: boolean;
  stepCounter?: { current: number; total: number };
}

export function StepHeader({ label, onBack, disabled, stepCounter }: StepHeaderProps) {
  return (
    <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
      <button
        type="button"
        onClick={onBack}
        disabled={disabled}
        className="inline-flex h-7 items-center gap-1 rounded border border-border/70 bg-background/60 px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground disabled:opacity-50"
        aria-label="Back"
      >
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Back</span>
      </button>
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {stepCounter ? (
        <span className="ml-auto text-[10px] text-muted-foreground/80">
          step {stepCounter.current} of {stepCounter.total}
        </span>
      ) : null}
    </div>
  );
}

interface TextStepProps {
  step: TextFlowStep;
  /** Initial value, e.g. when stepping forward then back into this step. */
  initialValue?: string;
  disabled?: boolean;
  onSubmit: (value: string) => void;
}

export function TextStep({ step, initialValue, disabled, onSubmit }: TextStepProps) {
  const [value, setValue] = useState(initialValue ?? '');
  const [showError, setShowError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const trimmed = value.trim();
  const required = step.required !== false;
  const patternFails =
    step.pattern && trimmed.length > 0 && !step.pattern.regex.test(trimmed);
  const canSubmit =
    !disabled && (!required || trimmed.length > 0) && !patternFails;

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!canSubmit) {
        setShowError(true);
        return;
      }
      onSubmit(trimmed);
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setShowError(false);
        }}
        onKeyDown={handleKeyDown}
        placeholder={step.placeholder}
        disabled={disabled}
        className="w-full border-0 border-b border-border/70 bg-transparent px-4 py-3 text-sm text-foreground outline-none focus:ring-0 disabled:opacity-60"
      />
      {showError && step.pattern && patternFails ? (
        <div className="border-b border-border/70 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {step.pattern.message}
        </div>
      ) : null}
    </>
  );
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'loaded'; options: FlowOption[] };

interface PickerStepProps {
  step: PickerFlowStep;
  disabled?: boolean;
  onSubmit: (value: string) => void;
}

export function PickerStep({ step, disabled, onSubmit }: PickerStepProps) {
  const [load, setLoad] = useState<LoadState>({ phase: 'loading' });
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [reloadTick, setReloadTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoad({ phase: 'loading' });
    Promise.resolve()
      .then(() => step.loadOptions())
      .then((options) => {
        if (cancelled) return;
        setLoad({ phase: 'loaded', options });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to load options';
        setLoad({ phase: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, [step, reloadTick]);

  const ranked = useMemo(() => {
    if (load.phase !== 'loaded') return [];
    const rankable = load.options.map((o) => ({
      type: 'option',
      title: o.label,
      subtitle: o.hint,
      keywords: [o.value],
      option: o,
    }));
    return rankAll(query, rankable, 100);
  }, [load, query]);

  useEffect(() => {
    setSelected(0);
  }, [ranked.length]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-picker-idx="${selected}"]`,
    );
    node?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (load.phase !== 'loaded') return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((i) => Math.min(ranked.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const entry = ranked[selected];
      if (entry) onSubmit(entry.option.value);
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={`Filter ${step.label.toLowerCase()}…`}
        disabled={disabled || load.phase === 'loading'}
        className="w-full border-0 border-b border-border/70 bg-transparent px-4 py-3 text-sm text-foreground outline-none focus:ring-0 disabled:opacity-60"
      />
      <div ref={listRef} className="max-h-[60vh] min-h-[120px] overflow-y-auto p-1">
        {load.phase === 'loading' ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            Loading…
          </div>
        ) : load.phase === 'error' ? (
          <div className="px-4 py-4 text-sm">
            <div className="mb-2 text-destructive">Failed to load: {load.message}</div>
            <button
              type="button"
              onClick={() => setReloadTick((t) => t + 1)}
              className="rounded border border-border/70 bg-background/60 px-2 py-1 text-xs text-foreground hover:bg-accent/40"
            >
              Retry
            </button>
          </div>
        ) : ranked.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            {load.options.length === 0
              ? step.emptyMessage ?? 'No options available'
              : 'No matches'}
          </div>
        ) : (
          ranked.map((entry, idx) => {
            const isSelected = idx === selected;
            return (
              <button
                key={entry.option.value}
                type="button"
                data-picker-idx={idx}
                onClick={() => onSubmit(entry.option.value)}
                onMouseEnter={() => setSelected(idx)}
                disabled={disabled}
                className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors disabled:opacity-60 ${
                  isSelected
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-accent/50 text-foreground'
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{entry.option.label}</span>
                {entry.option.hint ? (
                  <span className="shrink-0 truncate text-xs text-muted-foreground">
                    {entry.option.hint}
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </>
  );
}
