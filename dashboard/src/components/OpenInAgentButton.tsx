import { useEffect, useState } from 'react';
import { Terminal } from 'lucide-react';
import { cn } from '../lib/utils';
import { useRecreateFlow } from './useRecreateFlow';
import { useAgentsConfig } from '../hooks/useAgentsConfig';

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

/**
 * Hands a `syntaur://` URL to the OS so either the Electron app or the CLI URL
 * handler routes the click to a launched terminal at the assignment's worktree.
 *
 * Before firing, calls `POST /api/launch/preflight` (via {@link useRecreateFlow})
 * to confirm the configured terminal is installed and the recorded worktree
 * still exists. On a missing terminal it offers a confirm-to-fallback; on a
 * deleted worktree it offers a one-click recreate, then re-fires the open.
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

  const flow = useRecreateFlow();

  // Agent picker (assignment only — sessions pin their agent from the record).
  const agentsState = useAgentsConfig();
  const agents = agentsState.agents;
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  useEffect(() => {
    // `useAgentsConfig` resolves asynchronously (starts as []). Initialize once
    // it loads; preserve a still-valid current choice, else fall back to the
    // configured default agent, else the first one.
    if (agents.length === 0) return;
    setSelectedAgentId((prev) => {
      if (prev && agents.some((a) => a.id === prev)) return prev;
      const def = agents.find((a) => a.default) ?? agents[0];
      return def.id;
    });
  }, [agents]);

  const showAgentPicker = target.kind === 'assignment' && agents.length > 0;

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

  return (
    <>
      <div className="inline-flex items-center gap-1.5">
        {showAgentPicker && (
          <select
            value={selectedAgentId ?? ''}
            onChange={(e) => setSelectedAgentId(e.target.value)}
            disabled={flow.pending}
            title="Agent to launch (runner profile)"
            aria-label="Agent to launch"
            className={cn(
              'editor-input',
              size === 'compact' ? 'px-1.5 py-1 text-xs' : 'text-sm',
            )}
            onClick={(e) => e.stopPropagation()}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={() =>
            void flow.open(target, undefined, selectedAgentId ?? undefined)
          }
          disabled={flow.pending}
          title={title ?? defaultTitle}
          className={classes}
        >
          <Terminal className="size-3.5" />
          <span>{target.kind === 'session' ? 'Open' : 'Open in agent'}</span>
        </button>
      </div>
      {flow.dialogs}
    </>
  );
}
