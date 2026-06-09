import { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from './ui/dialog';
import {
  detectActiveToken,
  rankSuggestions,
  applySuggestion,
  tokenWarnings,
} from '../lib/launch-prompt-autocomplete';
import { cn } from '../lib/utils';

// Must match MAX_OPEN_PROMPT_LENGTH in src/launch/url.ts. The server is
// authoritative (it rejects an over-length prompt= param); this is the
// client-side guard so we surface it before launching instead of truncating.
const MAX_PROMPT_LENGTH = 2000;

interface PrefillResponse {
  template: string;
  knownPlaybookSlugs: string[];
}

interface LaunchPromptDialogProps {
  open: boolean;
  /** Assignment id to prefill + launch. */
  assignmentId: string;
  /** Agent the prefill/launch targets (omit for the configured default). */
  agentId?: string;
  /** Confirm with the (single-line) edited template — re-resolved at launch. */
  onConfirm: (prompt: string) => void;
  onOpenChange: (open: boolean) => void;
}

/**
 * The editable "Open in agent" prompt box (Phase B). Prefills the effective
 * launch TEMPLATE from `GET /api/launch/prompt`, offers `@`-token autocomplete
 * (driven entirely by `lib/launch-prompt-autocomplete`), shows advisory token
 * warnings, and returns the edited single-line text. Per-launch only — the
 * edit rides one launch and is never written to config.
 */
export function LaunchPromptDialog({
  open,
  assignmentId,
  agentId,
  onConfirm,
  onOpenChange,
}: LaunchPromptDialogProps) {
  const [value, setValue] = useState('');
  const [known, setKnown] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Prefill the template + the authoritative installed-slug set when opened.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setDismissed(false);
    const params = new URLSearchParams({ assignment: assignmentId });
    if (agentId) params.set('agent', agentId);
    fetch(`/api/launch/prompt?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        return (await res.json()) as PrefillResponse;
      })
      .then((body) => {
        if (cancelled) return;
        setValue(body.template ?? '');
        setKnown(body.knownPlaybookSlugs ?? []);
        setCaret((body.template ?? '').length);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, assignmentId, agentId]);

  const active = detectActiveToken(value, caret);
  const suggestions = active ? rankSuggestions(active.partial, known) : [];
  const showPopup = open && !loading && !dismissed && suggestions.length > 0;
  const warnings = tokenWarnings(value, known);
  const tooLong = value.length > MAX_PROMPT_LENGTH;

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setValue(e.target.value.replace(/[\r\n]+/g, ' ')); // single-line
    setCaret(e.target.selectionStart ?? e.target.value.length);
    setSelected(0);
    setDismissed(false);
  }

  function syncCaret(e: React.SyntheticEvent<HTMLTextAreaElement>) {
    setCaret(e.currentTarget.selectionStart ?? value.length);
  }

  function apply(suggestion: string) {
    if (!active) return;
    const result = applySuggestion(value, active, suggestion);
    setValue(result.text);
    setCaret(result.caret);
    setSelected(0);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
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
      apply(suggestions[selected]);
    } else if (e.key === 'Escape') {
      // Dismiss the popup only — keep stopPropagation so Radix doesn't also
      // close the dialog on this Escape.
      e.preventDefault();
      e.stopPropagation();
      setDismissed(true);
    }
  }

  function confirm() {
    if (tooLong || loading) return;
    onConfirm(value);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit launch prompt</DialogTitle>
          <DialogDescription>
            The first message the agent starts with. <code>@assignment</code> and{' '}
            <code>@&lt;playbook&gt;</code> tokens resolve at launch. This edit applies to
            this launch only.
          </DialogDescription>
        </DialogHeader>

        {loadError ? (
          <p className="text-sm text-error-foreground">Couldn't load the prompt: {loadError}</p>
        ) : (
          <div className="relative">
            <textarea
              ref={textareaRef}
              value={value}
              disabled={loading}
              rows={4}
              spellCheck={false}
              placeholder={loading ? 'Loading…' : '@assignment Run @<playbook> end-to-end.'}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onKeyUp={syncCaret}
              onClick={syncCaret}
              className={cn(
                'editor-input w-full font-mono text-sm',
                tooLong && 'border-error-foreground',
              )}
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
                      aria-selected={i === selected}
                      onMouseDown={(e) => {
                        // mousedown (not click) so the textarea keeps focus.
                        e.preventDefault();
                        apply(s);
                      }}
                      className={cn(
                        'flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-sm transition-colors hover:bg-accent',
                        i === selected && 'bg-accent',
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
        )}

        {warnings.length > 0 && !loadError && (
          <ul className="space-y-0.5 text-[11px] text-error-foreground">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        {tooLong && (
          <p className="text-[11px] text-error-foreground">
            Too long — keep it under {MAX_PROMPT_LENGTH} characters ({value.length}).
          </p>
        )}

        <DialogFooter>
          <button
            type="button"
            className="shell-action mt-0"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="shell-action mt-0 shell-action--cta"
            disabled={loading || tooLong || loadError !== null}
            onClick={confirm}
          >
            Launch
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
