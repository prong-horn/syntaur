import { useState } from 'react';
import { Link } from 'react-router-dom';
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
import { recreateWorktree, CreateWorktreeError } from '../lib/assignments';
import {
  continuationUrl,
  type ContinuationTarget,
  type ReopenMode,
} from '../lib/recreate-flow';

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
interface PreflightRecreate {
  kind: 'assignment' | 'session';
  id: string;
  projectSlug: string | null;
  assignmentSlug: string | null;
  deletedPath: string;
  repository: string | null;
  branch: string | null;
}
interface PreflightWorkspaceInvalid {
  ok: false;
  terminal: TerminalChoice;
  reason: 'workspace-path-invalid';
  message: string;
  /** Present when the missing worktree can be recreated with one click. */
  recreate?: PreflightRecreate;
}
type PreflightResponse = PreflightOk | PreflightMiss | PreflightWorkspaceInvalid;

/** A pending continuation: where to navigate once preflight/recreate clears. */
interface Pending {
  target: ContinuationTarget;
  mode?: ReopenMode;
}

/**
 * Shared launch flow for the "Open in agent" button and session Resume/Fork
 * actions: runs `POST /api/launch/preflight`, then either fires the
 * `syntaur://` deep link, offers a confirm-to-fallback when the terminal is
 * missing, or — when the recorded worktree was deleted — offers a one-click
 * recreate (or a read-only error when it can't be auto-recreated). Owns all the
 * dialogs so both call sites render identical UX; callers just render their own
 * trigger and `flow.dialogs`, calling `flow.open(target, mode)` on click.
 */
export function useRecreateFlow() {
  const [pending, setPending] = useState(false);
  const [miss, setMiss] = useState<PreflightMiss | null>(null);
  const [missPending, setMissPending] = useState<Pending | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [recreate, setRecreate] = useState<PreflightRecreate | null>(null);
  const [recreatePending, setRecreatePending] = useState<Pending | null>(null);
  const [recreating, setRecreating] = useState(false);
  const [recreateError, setRecreateError] = useState<string | null>(null);
  const [recreateNote, setRecreateNote] = useState<string | null>(null);

  async function open(target: ContinuationTarget, mode?: ReopenMode): Promise<void> {
    if (pending) return;
    setPending(true);
    try {
      const res = await fetch('/api/launch/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: { kind: target.kind, id: target.id } }),
      });
      if (!res.ok) {
        // Network/5xx — best effort: fire the link; the CLI/applet surfaces any
        // launch error itself.
        window.location.href = continuationUrl(target, mode);
        return;
      }
      const body = (await res.json()) as PreflightResponse;
      if (body.ok) {
        window.location.href = continuationUrl(target, mode);
        return;
      }
      if (body.reason === 'workspace-path-invalid') {
        // Do NOT navigate — the deep link would fail (or land in the wrong
        // directory). Offer recreate when possible; else the read-only reason.
        if (body.recreate) {
          setRecreate(body.recreate);
          setRecreatePending({ target, mode });
        } else {
          setWorkspaceError(body.message);
        }
        return;
      }
      setMiss(body);
      setMissPending({ target, mode });
    } catch (err) {
      console.warn('preflight failed, firing without override:', err);
      window.location.href = continuationUrl(target, mode);
    } finally {
      setPending(false);
    }
  }

  function confirmFallback() {
    if (!miss || !missPending) return;
    window.location.href = continuationUrl(
      missPending.target,
      missPending.mode,
      miss.suggestedFallback,
    );
    setMiss(null);
    setMissPending(null);
  }

  async function confirmRecreate() {
    if (!recreate || !recreatePending || recreating) return;
    setRecreating(true);
    setRecreateError(null);
    try {
      const result = await recreateWorktree({
        kind: recreate.kind,
        id: recreate.id,
        projectSlug: recreate.projectSlug,
        assignmentSlug: recreate.assignmentSlug,
      });
      const { target, mode } = recreatePending;
      setRecreate(null);
      setRecreatePending(null);
      // The worktree now exists at the exact recorded path — re-fire the
      // original open. A `syntaur://` href triggers the OS handler without
      // unloading this page, so any non-exact note below still renders.
      window.location.href = continuationUrl(target, mode);
      if (!result.exact && !result.alreadyExisted) {
        setRecreateNote(
          `Recreated from ${result.baseUsed} — the original branch couldn't be ` +
            `restored exactly, but the directory is back and your agent is opening.`,
        );
      }
    } catch (err) {
      setRecreateError(
        err instanceof CreateWorktreeError && err.stderr
          ? `${err.message}\n${err.stderr}`
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setRecreating(false);
    }
  }

  const dialogs = (
    <>
      <AlertDialog open={miss !== null} onOpenChange={(o) => !o && (setMiss(null), setMissPending(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{miss?.terminal} is not installed</AlertDialogTitle>
            <AlertDialogDescription>
              Open in <strong>{miss?.suggestedFallback}</strong> instead? You can
              change the default in{' '}
              <Link
                to="/settings"
                className="underline hover:text-foreground"
                onClick={() => {
                  setMiss(null);
                  setMissPending(null);
                }}
              >
                Settings
              </Link>
              .
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="shell-action mt-0">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="shell-action mt-0 bg-foreground text-background hover:opacity-90"
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
        onOpenChange={(o) => !o && setWorkspaceError(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Can't open in agent</AlertDialogTitle>
            <AlertDialogDescription>
              {workspaceError} Set a valid worktree or repository, then try again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction
              className="shell-action mt-0 bg-foreground text-background hover:opacity-90"
              onClick={() => setWorkspaceError(null)}
            >
              OK
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={recreate !== null}
        onOpenChange={(o) => {
          if (!o && !recreating) {
            // Closing without confirming = No: no worktree created, no launch.
            setRecreate(null);
            setRecreatePending(null);
            setRecreateError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Worktree was deleted</AlertDialogTitle>
            <AlertDialogDescription>
              The worktree at <code>{recreate?.deletedPath}</code> no longer
              exists. Recreate it
              {recreate?.branch ? (
                <>
                  {' '}
                  on branch <code>{recreate.branch}</code>
                </>
              ) : null}{' '}
              so this can open?
            </AlertDialogDescription>
          </AlertDialogHeader>
          {recreateError && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs text-destructive">
              {recreateError}
            </pre>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel className="shell-action mt-0" disabled={recreating}>
              No
            </AlertDialogCancel>
            <AlertDialogAction
              className="shell-action mt-0 bg-foreground text-background hover:opacity-90"
              disabled={recreating}
              onClick={(event) => {
                event.preventDefault();
                void confirmRecreate();
              }}
            >
              {recreating ? 'Recreating…' : 'Yes, recreate'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={recreateNote !== null}
        onOpenChange={(o) => !o && setRecreateNote(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Worktree recreated</AlertDialogTitle>
            <AlertDialogDescription>{recreateNote}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction
              className="shell-action mt-0 bg-foreground text-background hover:opacity-90"
              onClick={() => setRecreateNote(null)}
            >
              OK
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );

  return { open, pending, dialogs };
}
