import { useEffect, useRef, useState } from 'react';
import { Terminal, ChevronDown, Check } from 'lucide-react';
import { cn } from '../lib/utils';
import { useRecreateFlow } from './useRecreateFlow';
import { useAgentsConfig, useClaudeDiscoveredAgents } from '../hooks/useAgentsConfig';
import { LaunchPromptDialog } from './LaunchPromptDialog';

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

  // Assignment launches open an editable prompt box first; sessions launch
  // directly (their first message comes from history).
  const [promptDialogAgent, setPromptDialogAgent] = useState<{ agentId?: string } | null>(null);

  // Agent picker (assignment only — sessions pin their agent from the record).
  const agentsState = useAgentsConfig();
  const agents = agentsState.agents;
  // Discovered Claude agent definitions (`~/.claude/agents`) — assignment only,
  // offered as a "Run as agent" identity overlay (`--agent <name>`). Only usable
  // when a configured Claude-compatible base profile exists to carry the
  // `--agent` launch (resolveAssignmentPlan needs a real agent id; a custom
  // agents list may not include one named `claude`).
  const discoveredClaude = useClaudeDiscoveredAgents();
  const claudeBase = agents.find((a) => a.id === 'claude' || /claude/i.test(a.command));
  const showClaudeIdentities =
    target.kind === 'assignment' && discoveredClaude.length > 0 && Boolean(claudeBase);
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

  // Split-button menu (the chevron half) — only when there's a choice to make:
  // multiple configured agents OR discovered Claude identities to run as.
  const showAgentPicker =
    target.kind === 'assignment' && (agents.length > 1 || showClaudeIdentities);
  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null;
  const rootRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  function launch(agentId?: string) {
    if (target.kind === 'assignment') {
      // Resolve which agent this launch targets (an omitted agentId means the
      // configured default — mirror the launch-plan resolver's fallback).
      const agent =
        agents.find((a) => a.id === agentId) ??
        agents.find((a) => a.default) ??
        agents[0];
      // If the agent already has a prompt configured in settings — either the
      // editable `launchPrompt` or the legacy `playbook` — launch straight away:
      // omitting the prompt override lets the server resolve that configured
      // template. Only pop the editable box when there's nothing set in
      // settings, i.e. the launch would otherwise fall back to the bare
      // `/grab-assignment` seed.
      const hasConfiguredPrompt =
        Boolean(agent?.launchPrompt?.trim()) || Boolean(agent?.playbook?.trim());
      if (hasConfiguredPrompt) {
        void flow.open(target, undefined, agentId);
      } else {
        // Open the editable prompt box; the actual launch fires on its Confirm.
        setPromptDialogAgent({ agentId });
      }
    } else {
      void flow.open(target, undefined, agentId);
    }
  }

  // Launch the assignment with a discovered Claude agent identity overlaid
  // (`<claude-base> --agent <name>`). The agent definition carries its own
  // prompt + model, so we fire directly (no editable-prompt box) and let the
  // server resolve the default seed; `agentName` rides the deep link, carried by
  // the configured Claude base profile's id.
  function launchAsClaudeAgent(name: string) {
    if (!claudeBase) return;
    setMenuOpen(false);
    void flow.open(target, undefined, claudeBase.id, undefined, name);
  }

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

  const launchLabel = target.kind === 'session' ? 'Open' : 'Open in agent';

  return (
    <>
      <div className="relative inline-flex" ref={rootRef}>
        <div className="inline-flex items-stretch">
          {/* Primary action: launch with the currently-selected agent. */}
          <button
            type="button"
            onClick={() => launch(selectedAgentId ?? undefined)}
            disabled={flow.pending}
            title={
              (title ?? defaultTitle) +
              (showAgentPicker && selectedAgent ? ` (${selectedAgent.label})` : '')
            }
            className={cn(classes, showAgentPicker && 'rounded-r-none')}
          >
            <Terminal className="size-3.5" />
            <span>{launchLabel}</span>
          </button>

          {/* Chevron half: opens the agent picker menu. */}
          {showAgentPicker && (
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              disabled={flow.pending}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Choose which agent to launch"
              title="Choose which agent to launch"
              className={cn(
                classes,
                '-ml-px rounded-l-none',
                size === 'compact' ? 'px-1' : 'px-1.5',
              )}
            >
              <ChevronDown
                className={cn(
                  'size-3.5 opacity-70 transition-transform',
                  menuOpen && 'rotate-180',
                )}
              />
            </button>
          )}
        </div>

        {menuOpen && showAgentPicker && (
          <div
            role="menu"
            aria-label="Open with agent"
            className="absolute right-0 top-full z-30 mt-1 min-w-[180px] overflow-hidden rounded-md border border-border/70 bg-background py-1 shadow-lg"
          >
            <div className="px-2.5 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
              Open with agent
            </div>
            {agents.map((a) => (
              <button
                key={a.id}
                type="button"
                role="menuitemradio"
                aria-checked={a.id === selectedAgentId}
                onClick={() => {
                  setSelectedAgentId(a.id);
                  setMenuOpen(false);
                  launch(a.id);
                }}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent"
              >
                <Check
                  className={cn(
                    'size-3.5 shrink-0',
                    a.id === selectedAgentId ? 'opacity-100' : 'opacity-0',
                  )}
                />
                <span className="truncate">{a.label}</span>
                {a.default && (
                  <span className="ml-auto text-[10px] text-muted-foreground/60">
                    default
                  </span>
                )}
              </button>
            ))}
            {showClaudeIdentities && (
              <>
                <div className="mt-1 border-t border-border/60 px-2.5 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                  Run as Claude agent
                </div>
                {discoveredClaude.map((a) => (
                  <button
                    key={`claude-agent:${a.name}`}
                    type="button"
                    role="menuitem"
                    onClick={() => launchAsClaudeAgent(a.name)}
                    title={a.description ?? a.name}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent"
                  >
                    <span className="size-3.5 shrink-0" />
                    <span className="truncate">{a.name}</span>
                    {a.model && (
                      <span className="ml-auto text-[10px] text-muted-foreground/60">
                        {a.model}
                      </span>
                    )}
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>
      {flow.dialogs}
      {target.kind === 'assignment' && promptDialogAgent && (
        <LaunchPromptDialog
          open
          assignmentId={target.id}
          agentId={promptDialogAgent.agentId}
          onConfirm={(prompt) => {
            void flow.open(target, undefined, promptDialogAgent.agentId, prompt);
          }}
          onOpenChange={(o) => {
            if (!o) setPromptDialogAgent(null);
          }}
        />
      )}
    </>
  );
}
