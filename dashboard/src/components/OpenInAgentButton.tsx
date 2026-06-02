import { useState } from 'react';
import { Terminal } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '../lib/utils';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import type { TerminalChoice } from '@shared/terminal-schema';

interface OpenInAgentButtonProps {
  /** Either an assignment id or a session id. */
  target: { kind: 'assignment'; id: string } | { kind: 'session'; id: string };
  /**
   * The assignment's worktreePath. Preferred cwd for the launch. May be null
   * if the assignment has no worktree yet — in that case `repository` is used.
   */
  worktreePath?: string | null;
  /**
   * The assignment's repository path — the fallback cwd when there is no
   * worktree. The button is disabled (assignment-mode) only when BOTH
   * worktreePath and repository are absent. Session-mode falls back to
   * session.path so it stays enabled regardless.
   */
  repository?: string | null;
  /** Visual size — `default` for header action group, `compact` for row actions. */
  size?: 'default' | 'compact';
  /** Override the tooltip. */
  title?: string;
}

interface PreflightOk {
  ok: true;
  terminal: TerminalChoice;
}
interface PreflightMiss {
  ok: false;
  terminal: TerminalChoice;
  reason: 'not-installed';
  suggestedFallback: TerminalChoice;
}
interface PreflightWorkspaceInvalid {
  ok: false;
  terminal: TerminalChoice;
  reason: 'workspace-path-invalid';
  message: string;
}
type PreflightResponse =
  | PreflightOk
  | PreflightMiss
  | PreflightWorkspaceInvalid;

function baseHref(
  target: OpenInAgentButtonProps['target'],
  fallback?: TerminalChoice,
): string {
  const base = `syntaur://open?${target.kind}=${encodeURIComponent(target.id)}`;
  return fallback ? `${base}&terminal=${encodeURIComponent(fallback)}` : base;
}

/**
 * Hands a `syntaur://` URL to the OS so either the Electron app or the CLI URL
 * handler routes the click to a launched terminal at the assignment's worktree.
 *
 * Before firing, calls `POST /api/launch/preflight` to confirm the configured
 * terminal is installed. On miss, shows a confirm-to-fallback dialog and
 * appends `&terminal=<fallback>` to the URL so the launch plan honors the
 * override for this one click (no config mutation).
 *
 * Renders as a disabled `<button>` when assignment-mode is missing
 * worktreePath — no point in firing the link if we have nothing to cd into.
 */
export function OpenInAgentButton({
  target,
  worktreePath = null,
  repository = null,
  size = 'default',
  title,
}: OpenInAgentButtonProps) {
  const disabled =
    target.kind === 'assignment' && !worktreePath && !repository;

  const [miss, setMiss] = useState<PreflightMiss | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const defaultTitle =
    target.kind === 'assignment'
      ? 'Open this assignment in your configured terminal + agent'
      : 'Resume this session in its agent';
  const disabledTitle =
    'Set a workspace path first — see the Workspace Before Code playbook';

  const classes = cn(
    'shell-action',
    size === 'compact' &&
      'inline-flex items-center justify-center px-2 py-1 text-xs',
    'disabled:cursor-not-allowed disabled:opacity-50',
  );

  if (disabled) {
    return (
      <button
        type="button"
        disabled
        title={disabledTitle}
        className={classes}
        aria-disabled
      >
        <Terminal className="size-3.5" />
        <span>Open in agent</span>
      </button>
    );
  }

  async function handleClick() {
    if (pending) return;
    setPending(true);
    try {
      const res = await fetch('/api/launch/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      });
      if (!res.ok) {
        // Network/5xx — best effort: fire the link; the CLI/applet will surface
        // any launch error itself.
        window.location.href = baseHref(target);
        return;
      }
      const body = (await res.json()) as PreflightResponse;
      if (body.ok) {
        window.location.href = baseHref(target);
        return;
      }
      if (body.reason === 'workspace-path-invalid') {
        // Do NOT navigate — opening the deep link would fail (or land in the
        // wrong directory). Show the reason inline instead.
        setWorkspaceError(body.message);
        return;
      }
      setMiss(body);
    } catch (err) {
      console.warn('preflight failed, firing without override:', err);
      window.location.href = baseHref(target);
    } finally {
      setPending(false);
    }
  }

  function confirmFallback() {
    if (!miss) return;
    window.location.href = baseHref(target, miss.suggestedFallback);
    setMiss(null);
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        title={title ?? defaultTitle}
        className={classes}
      >
        <Terminal className="size-3.5" />
        <span>{target.kind === 'session' ? 'Open' : 'Open in agent'}</span>
      </button>

      <AlertDialog open={miss !== null} onOpenChange={(open) => !open && setMiss(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {miss?.terminal} is not installed
            </AlertDialogTitle>
            <AlertDialogDescription>
              Open in <strong>{miss?.suggestedFallback}</strong> instead? You can
              change the default in{' '}
              <Link
                to="/settings"
                className="underline hover:text-foreground"
                onClick={() => setMiss(null)}
              >
                Settings
              </Link>
              .
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="shell-action mt-0">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="shell-action mt-0 shell-action--cta"
              onClick={(event) => {
                event.preventDefault();
                confirmFallback();
              }}
            >
              Open in {miss?.suggestedFallback}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={workspaceError !== null}
        onOpenChange={(open) => !open && setWorkspaceError(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Can't open in agent</AlertDialogTitle>
            <AlertDialogDescription>
              {workspaceError} Set a valid worktree or repository for this
              assignment, then try again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction
              className="shell-action mt-0 shell-action--cta"
              onClick={() => setWorkspaceError(null)}
            >
              OK
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
