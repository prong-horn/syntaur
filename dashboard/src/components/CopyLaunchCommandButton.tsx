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

    // Resolve the launch command from the server. Kept as a promise (rather
    // than awaited up front) so it can be handed to ClipboardItem below: the
    // clipboard write must be *initiated* synchronously inside the click
    // handler or the browser drops the transient user activation once we
    // `await fetch(...)`, and rejects the write with a NotAllowedError. Safari
    // enforces this always; Chrome enforces it when the tab isn't focused.
    const resolved: Promise<{ command: string; fallbackWarning?: string }> =
      (async () => {
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
        return {
          command: data.command,
          fallbackWarning:
            typeof data.fallbackWarning === 'string' && data.fallbackWarning
              ? data.fallbackWarning
              : undefined,
        };
      })();

    try {
      const canWriteAsync =
        typeof navigator.clipboard?.write === 'function' &&
        typeof ClipboardItem !== 'undefined';

      let fallbackWarning: string | undefined;

      if (canWriteAsync) {
        // ClipboardItem accepts a promise of the payload, so the write is
        // initiated within the gesture and the fetched command streams in
        // without losing user activation.
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': resolved.then(
              (r) => new Blob([r.command], { type: 'text/plain' }),
            ),
          }),
        ]);
        fallbackWarning = (await resolved).fallbackWarning;
      } else {
        // Older browsers without ClipboardItem/clipboard.write: fall back to
        // writeText. This can still hit the activation limit above, but it's
        // the best available path on those engines.
        const r = await resolved;
        if (
          !navigator.clipboard ||
          typeof navigator.clipboard.writeText !== 'function'
        ) {
          throw new Error('Clipboard API is unavailable in this context.');
        }
        await navigator.clipboard.writeText(r.command);
        fallbackWarning = r.fallbackWarning;
      }

      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      if (fallbackWarning) {
        onNotice?.(fallbackWarning);
      }
    } catch (err) {
      // If the fetch/payload step is what failed, surface that specific error
      // rather than the generic clipboard rejection bubbled up by the write.
      let surfaced = err instanceof Error ? err : new Error(String(err));
      try {
        await resolved;
      } catch (fetchErr) {
        surfaced = fetchErr instanceof Error ? fetchErr : new Error(String(fetchErr));
      }
      onError?.(surfaced);
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
