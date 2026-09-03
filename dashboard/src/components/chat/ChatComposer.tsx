import { useRef, useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { applySuggestion, detectActiveToken } from '../../lib/launch-prompt-autocomplete';
import { agentColorClasses, rankAgentTokens } from '../../lib/chat-format';
import { cn } from '../../lib/utils';
import type { ChatAgentSummary } from '../../lib/chat-types';

/**
 * The composer, with `@agent` autocomplete over the ATTACHED agents.
 *
 * Tokenizing and insertion are the launch-prompt primitives verbatim
 * (`detectActiveToken` / `applySuggestion`), so what the box offers and what
 * `parseMentions` reads on the server are the same grammar: `@` at start or
 * after whitespace, then `[A-Za-z0-9_-]+`. Only the ranking differs — the
 * candidates here are agents, not playbooks.
 */

export interface ChatComposerProps {
  agents: ChatAgentSummary[];
  defaultAgentId: string | null;
  disabled?: boolean;
  onSend: (text: string) => Promise<void>;
}

export function ChatComposer({ agents, defaultAgentId, disabled, onSend }: ChatComposerProps) {
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  const active = detectActiveToken(draft, caret);
  const suggestions = active ? rankAgentTokens(active.partial, agents.map((a) => a.id)) : [];
  const showPopup = !dismissed && suggestions.length > 0;
  const activeIndex = Math.min(selected, Math.max(0, suggestions.length - 1));
  const canSend = draft.trim().length > 0 && !sending && !disabled;

  function apply(id: string | undefined): void {
    if (!active || !id) return;
    const result = applySuggestion(draft, active, id);
    setDraft(result.text);
    setCaret(result.caret);
    setSelected(0);
    // The caret lands inside the token just inserted, which would re-open the
    // popup at once — keep it closed until the user types again.
    setDismissed(true);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) {
        el.focus();
        el.setSelectionRange(result.caret, result.caret);
      }
    });
  }

  async function submit(): Promise<void> {
    if (!canSend) return;
    setSending(true);
    try {
      await onSend(draft);
      setDraft('');
      setCaret(0);
    } catch {
      // The hook surfaces the error; keep the draft so nothing is lost.
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (showPopup) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelected((s) => Math.min(s + 1, suggestions.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelected((s) => Math.max(s - 1, 0));
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        apply(suggestions[activeIndex]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(true);
        return;
      }
    }
    // Enter sends, Shift+Enter is a newline — the chat convention.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }

  const placeholder =
    agents.length === 0
      ? 'No agents are attached — open “Manage agents” to add one'
      : defaultAgentId
        ? `Message @${defaultAgentId} or mention an agent… (Enter to send, Shift+Enter for a newline)`
        : 'Mention an agent to start… (Enter to send, Shift+Enter for a newline)';

  return (
    <div className="flex items-end gap-2">
      <div className="relative flex-1">
        <textarea
          ref={ref}
          value={draft}
          rows={2}
          placeholder={placeholder}
          aria-label="Chat message"
          disabled={disabled}
          onChange={(event) => {
            setDraft(event.target.value);
            setCaret(event.target.selectionStart ?? event.target.value.length);
            setSelected(0);
            setDismissed(false);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(event) => setCaret(event.currentTarget.selectionStart ?? draft.length)}
          onClick={(event) => setCaret(event.currentTarget.selectionStart ?? draft.length)}
          className="min-h-[3rem] w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-60"
        />
        {showPopup && (
          <ul
            role="listbox"
            className="absolute bottom-full left-0 right-0 z-30 mb-1 max-h-48 overflow-auto rounded-md border border-border/70 bg-background py-1 shadow-lg"
          >
            {suggestions.map((id, index) => {
              const agent = agents.find((a) => a.id === id);
              return (
                <li key={id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    onMouseDown={(event) => {
                      // mousedown (not click) so the textarea keeps focus.
                      event.preventDefault();
                      apply(id);
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent',
                      index === activeIndex && 'bg-accent',
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-5 w-5 items-center justify-center rounded text-[10px] font-medium',
                        agentColorClasses(agent?.color ?? 'slate'),
                      )}
                      aria-hidden
                    >
                      {agent?.avatar ?? '?'}
                    </span>
                    <span className="font-mono">@{id}</span>
                    <span className="truncate text-xs text-muted-foreground">{agent?.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <button
        type="button"
        onClick={() => void submit()}
        disabled={!canSend}
        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        Send
      </button>
    </div>
  );
}
