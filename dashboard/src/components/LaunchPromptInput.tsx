import { useRef, useState } from 'react';
import {
  detectActiveToken,
  rankSuggestions,
  applySuggestion,
} from '../lib/launch-prompt-autocomplete';
import { cn } from '../lib/utils';

interface LaunchPromptInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Installed playbook slugs offered after `@` (alongside reserved `@assignment`). */
  knownSlugs: readonly string[];
  rows?: number;
  placeholder?: string;
  /** Applied to the underlying textarea. */
  className?: string;
  /** Applied to the relative wrapper that anchors the suggestion popup. */
  wrapperClassName?: string;
  /** Collapse pasted newlines to spaces (single-line config field). */
  singleLine?: boolean;
  'aria-label'?: string;
}

/**
 * A textarea with `@`-token autocomplete for launch prompts: type `@` to pick
 * `@assignment` or an installed playbook by slug (no need to go look them up).
 * Tokenizing/ranking/insertion are delegated to `lib/launch-prompt-autocomplete`,
 * which mirrors the server resolver's grammar. The full per-launch editor lives
 * in `LaunchPromptDialog`; this is the inline field used in the agents config.
 */
export function LaunchPromptInput({
  value,
  onChange,
  knownSlugs,
  rows = 2,
  placeholder,
  className,
  wrapperClassName,
  singleLine,
  'aria-label': ariaLabel,
}: LaunchPromptInputProps) {
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  const active = detectActiveToken(value, caret);
  const suggestions = active ? rankSuggestions(active.partial, knownSlugs) : [];
  const showPopup = !dismissed && suggestions.length > 0;
  // Clamp the highlight in case the suggestion list shrank under it.
  const activeIndex = Math.min(selected, Math.max(0, suggestions.length - 1));

  const normalize = (text: string) => (singleLine ? text.replace(/[\r\n]+/g, ' ') : text);

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    onChange(normalize(e.target.value));
    setCaret(e.target.selectionStart ?? e.target.value.length);
    setSelected(0);
    setDismissed(false);
  }

  // Caret moves (clicks, Home/End, etc.) change which token is active. Don't
  // reset `selected` here — that would fight ArrowUp/ArrowDown navigation, whose
  // keyup also lands on this handler.
  function syncCaret(e: React.SyntheticEvent<HTMLTextAreaElement>) {
    setCaret(e.currentTarget.selectionStart ?? value.length);
  }

  function apply(suggestion: string | undefined) {
    if (!active || !suggestion) return;
    const result = applySuggestion(value, active, suggestion);
    onChange(normalize(result.text));
    setCaret(result.caret);
    setSelected(0);
    // Caret lands inside the just-inserted token, so it would otherwise re-open
    // immediately — keep it closed until the user types again.
    setDismissed(true);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) {
        el.focus();
        el.setSelectionRange(result.caret, result.caret);
      }
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!showPopup) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      apply(suggestions[activeIndex]); // apply() guards an out-of-range/undefined pick
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(true);
    }
  }

  return (
    <div className={cn('relative', wrapperClassName)}>
      <textarea
        ref={ref}
        value={value}
        rows={rows}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onKeyUp={syncCaret}
        onClick={syncCaret}
        className={className}
      />
      {showPopup && (
        <ul
          role="listbox"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-48 overflow-auto rounded-md border border-border/70 bg-background py-1 shadow-lg"
        >
          {suggestions.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                onMouseDown={(e) => {
                  // mousedown (not click) so the textarea keeps focus.
                  e.preventDefault();
                  apply(s);
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-sm transition-colors hover:bg-accent',
                  i === activeIndex && 'bg-accent',
                )}
              >
                <span className="text-muted-foreground">@</span>
                <span className="truncate">{s}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
