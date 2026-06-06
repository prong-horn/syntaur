import { useState } from 'react';
import { Check, TerminalSquare } from 'lucide-react';

interface CopyLaunchCommandButtonProps {
  sessionId: string;
  disabled?: boolean;
  disabledReason?: string;
  /** Called when the fetch, payload, or clipboard write fails. */
  onError?: (error: Error) => void;
  /**
   * Called after a successful copy when the resolved plan carries a
   * `fallbackWarning` (e.g. the recorded worktree is gone and a fallback cwd
   * was used). Lets the caller surface a non-fatal notice; normal copies fire
   * nothing here — the in-button Check is the confirmation.
   */
  onNotice?: (message: string) => void;
}

/**
 * Copies the EXACT shell command the session's Resume button would run —
 * `cd '<cwd>' && '<agent>' '--resume' '<id>'` — by fetching it from
 * `GET /api/launch/command`. The command and cwd are resolved server-side by
 * the same launch-plan logic the button uses, so the copied command can never
 * drift from what actually launches (and the cwd is correct even when the
 * session wasn't recorded in the worktree).
 *
 * The command must be fetched (cwd is resolved server-side and can go stale),
 * so unlike the static {@link CopyButton} this copies asynchronously on click.
 */
export function CopyLaunchCommandButton({
  sessionId,
  disabled = false,
  disabledReason,
  onError,
  onNotice,
}: CopyLaunchCommandButtonProps) {
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);

  async function handleCopy() {
    if (disabled || pending) return;
    setPending(true);
    try {
      const res = await fetch(
        `/api/launch/command?session=${encodeURIComponent(sessionId)}&mode=resume`,
      );
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json().catch(() => null)) as
        | { command?: unknown; fallbackWarning?: unknown }
        | null;
      if (!data || typeof data.command !== 'string') {
        throw new Error('Malformed response from launch command endpoint');
      }
      if (
        !navigator.clipboard ||
        typeof navigator.clipboard.writeText !== 'function'
      ) {
        throw new Error('Clipboard API is unavailable in this context.');
      }
      await navigator.clipboard.writeText(data.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      if (typeof data.fallbackWarning === 'string' && data.fallbackWarning) {
        onNotice?.(data.fallbackWarning);
      }
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setPending(false);
    }
  }

  if (disabled) {
    return (
      <button
        type="button"
        disabled
        aria-disabled="true"
        className="cursor-not-allowed text-muted-foreground/50"
        title={disabledReason ?? 'Copy launch command unavailable'}
        aria-label="Copy launch command"
      >
        <TerminalSquare className="h-3 w-3" aria-hidden="true" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      disabled={pending}
      className="text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded disabled:cursor-wait"
      title={copied ? 'Copied!' : 'Copy launch command (cd + resume)'}
      aria-label="Copy launch command"
    >
      {copied
        ? <Check className="h-3 w-3 text-status-completed-foreground" aria-hidden="true" />
        : <TerminalSquare className="h-3 w-3" aria-hidden="true" />}
    </button>
  );
}
