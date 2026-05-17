import { Terminal } from 'lucide-react';
import { cn } from '../lib/utils';

interface OpenInAgentButtonProps {
  /** Either an assignment id or a session id. */
  target: { kind: 'assignment'; id: string } | { kind: 'session'; id: string };
  /**
   * The assignment's worktreePath. When null, the button renders as disabled
   * with a tooltip pointing at the Workspace Before Code playbook. Required
   * only for assignment-mode; session-mode falls back to session.path so the
   * button stays enabled even without a worktree set.
   */
  worktreePath?: string | null;
  /** Visual size — `default` for header action group, `compact` for row actions. */
  size?: 'default' | 'compact';
  /** Override the tooltip. */
  title?: string;
}

/**
 * `<a href="syntaur://open?...">` affordance that hands the URL to the OS so
 * either the Electron app (when installed and registered) or the CLI URL
 * handler routes the click to a launched terminal at the assignment's worktree.
 *
 * Renders as a disabled `<button>` when assignment-mode is missing
 * worktreePath — no point in firing the link if we have nothing to cd into.
 */
export function OpenInAgentButton({
  target,
  worktreePath = null,
  size = 'default',
  title,
}: OpenInAgentButtonProps) {
  const disabled =
    target.kind === 'assignment' && (worktreePath == null || worktreePath === '');

  const href = `syntaur://open?${target.kind}=${encodeURIComponent(target.id)}`;
  const defaultTitle =
    target.kind === 'assignment'
      ? 'Open this assignment in your configured terminal + agent'
      : 'Resume this session in its agent';
  const disabledTitle =
    'Set a worktree first — see the Workspace Before Code playbook';

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

  return (
    <a
      href={href}
      title={title ?? defaultTitle}
      className={classes}
      // syntaur:// links should never end up in the SPA navigation stack —
      // the OS handler intercepts and we don't want React Router rewriting it.
    >
      <Terminal className="size-3.5" />
      <span>{target.kind === 'session' ? 'Open' : 'Open in agent'}</span>
    </a>
  );
}
