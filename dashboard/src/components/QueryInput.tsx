/**
 * Controlled AQL query input with inline error display and autocomplete dropdown.
 *
 * This component is PRESENTATIONAL + CONTROLLED: it does not fetch config or
 * own query state. The consuming page builds the FieldRegistry with
 * `buildQueryRegistry(factDeclarations)` and passes it in as `registry`.
 *
 * Error format: `at {pos}: {message}` — matches ls.ts:119's rendering.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FieldRegistry, CompiledQuery } from '@shared/query';
import { compileQuery } from '@shared/query';
import type { FactDeclaration } from '@shared/fact-registry';
import type { ValueSuggestionSources } from '../lib/query-autocomplete';
import {
  detectCaretContext,
  rankFieldSuggestions,
  getValueSuggestions,
  applySuggestion,
} from '../lib/query-autocomplete';
import type { QueryError } from '@shared/query';

// ── Props ─────────────────────────────────────────────────────────────────────

export interface QueryInputProps {
  /** Controlled input value. */
  value: string;
  /** Called on every keystroke with the new raw query string. */
  onChange: (value: string) => void;
  /**
   * Called with the compiled query when the input compiles without errors, or
   * null when the input is empty or has errors.
   */
  onCompiled?: (compiled: CompiledQuery | null) => void;
  /** Field registry built by the page: `buildQueryRegistry(factDeclarations)`. */
  registry: FieldRegistry;
  /** Used for field name autocomplete. */
  declarations: FactDeclaration[];
  /** Value suggestion source lists derived from board data / config. */
  valueSources: ValueSuggestionSources;
  placeholder?: string;
  className?: string;
}

// ── Debounce ──────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 180;

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function QueryInput({
  value,
  onChange,
  onCompiled,
  registry,
  declarations,
  valueSources,
  placeholder = 'AQL query (e.g. status:active AND priority:high)',
  className,
}: QueryInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLUListElement>(null);

  // Compile after debounce so we don't re-parse on every keystroke.
  const debouncedValue = useDebounced(value, DEBOUNCE_MS);
  const [errors, setErrors] = useState<QueryError[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestionKind, setSuggestionKind] = useState<'field' | 'value'>('field');
  const [activeSuggestion, setActiveSuggestion] = useState<number>(-1);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  // Track current caret position so suggestion application can splice correctly.
  const caretRef = useRef<number>(value.length);

  // ── Compilation ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (debouncedValue.trim() === '') {
      setErrors([]);
      onCompiled?.(null);
      return;
    }
    const result = compileQuery(debouncedValue, registry);
    if (result.errors.length > 0) {
      setErrors(result.errors);
      onCompiled?.(null);
    } else {
      setErrors([]);
      onCompiled?.(result.query);
    }
  }, [debouncedValue, registry, onCompiled]);

  // ── Autocomplete ───────────────────────────────────────────────────────────

  const refreshSuggestions = useCallback(
    (inputValue: string, caret: number) => {
      const ctx = detectCaretContext(inputValue, caret);
      if (!ctx) {
        setSuggestions([]);
        setDropdownOpen(false);
        return;
      }
      if (ctx.kind === 'field') {
        const candidates = rankFieldSuggestions(ctx.partial, declarations);
        setSuggestions(candidates);
        setSuggestionKind('field');
        setDropdownOpen(candidates.length > 0);
      } else {
        const candidates = getValueSuggestions(ctx.field, ctx.partial, valueSources, registry);
        setSuggestions(candidates);
        setSuggestionKind('value');
        setDropdownOpen(candidates.length > 0);
      }
      setActiveSuggestion(-1);
    },
    [declarations, valueSources, registry],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      const caret = e.target.selectionStart ?? newValue.length;
      caretRef.current = caret;
      onChange(newValue);
      refreshSuggestions(newValue, caret);
    },
    [onChange, refreshSuggestions],
  );

  const handleSelect = useCallback(
    (suggestion: string) => {
      const input = inputRef.current;
      const caret = input?.selectionStart ?? caretRef.current;
      const ctx = detectCaretContext(value, caret);
      if (!ctx) return;
      const { text, caret: newCaret } = applySuggestion(value, ctx, suggestion);
      onChange(text);
      setDropdownOpen(false);
      setSuggestions([]);
      // Restore focus + caret after React re-renders.
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.setSelectionRange(newCaret, newCaret);
          caretRef.current = newCaret;
        }
      });
    },
    [value, onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!dropdownOpen || suggestions.length === 0) return;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setActiveSuggestion((i) => Math.min(i + 1, suggestions.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setActiveSuggestion((i) => Math.max(i - 1, -1));
          break;
        case 'Enter':
        case 'Tab':
          if (activeSuggestion >= 0) {
            e.preventDefault();
            handleSelect(suggestions[activeSuggestion]);
          }
          break;
        case 'Escape':
          setDropdownOpen(false);
          setSuggestions([]);
          break;
      }
    },
    [dropdownOpen, suggestions, activeSuggestion, handleSelect],
  );

  const handleBlur = useCallback(() => {
    // Delay close so a click on a suggestion fires first.
    setTimeout(() => setDropdownOpen(false), 120);
  }, []);

  const handleFocus = useCallback(() => {
    const caret = inputRef.current?.selectionStart ?? value.length;
    refreshSuggestions(value, caret);
  }, [value, refreshSuggestions]);

  // ── Render ─────────────────────────────────────────────────────────────────

  const hasErrors = errors.length > 0 && debouncedValue.trim() !== '';

  return (
    <div className={`relative flex flex-col gap-1 ${className ?? ''}`}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        onFocus={handleFocus}
        placeholder={placeholder}
        aria-label="AQL query input"
        aria-expanded={dropdownOpen}
        aria-haspopup="listbox"
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        className={[
          'h-9 w-full rounded-md border bg-background px-3 py-1.5 font-mono text-sm text-foreground outline-none transition',
          hasErrors
            ? 'border-destructive focus:border-destructive focus:ring-2 focus:ring-destructive/30'
            : 'border-border/60 focus:border-primary focus:ring-2 focus:ring-ring/30',
        ].join(' ')}
      />

      {/* Autocomplete dropdown */}
      {dropdownOpen && suggestions.length > 0 && (
        <ul
          ref={dropdownRef}
          role="listbox"
          aria-label={suggestionKind === 'field' ? 'Field suggestions' : 'Value suggestions'}
          className="absolute top-full z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md"
        >
          {suggestions.map((s, i) => (
            <li
              key={s}
              role="option"
              aria-selected={i === activeSuggestion}
              onMouseDown={(e) => {
                // Prevent blur from firing before click is processed.
                e.preventDefault();
                handleSelect(s);
              }}
              className={[
                'cursor-pointer px-3 py-1.5 font-mono text-sm',
                i === activeSuggestion
                  ? 'bg-accent text-accent-foreground'
                  : 'text-foreground hover:bg-accent/50',
              ].join(' ')}
            >
              {s}
            </li>
          ))}
        </ul>
      )}

      {/* Inline error display: `at {pos}: {message}` per ls.ts:119 */}
      {hasErrors && (
        <ul className="space-y-0.5" role="alert" aria-live="polite">
          {errors.map((err, i) => (
            <li key={i} className="font-mono text-xs text-destructive">
              at {err.pos}: {err.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
