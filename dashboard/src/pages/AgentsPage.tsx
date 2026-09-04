import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bot, Plus } from 'lucide-react';
import { AgentListRow } from '../components/agents/AgentListRow';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { useToast, Toaster } from '../components/Toast';
import { useChatAgents } from '../hooks/useChatAgents';
import { deleteChatAgent, testChatAgent } from '../lib/chat-api';
import type { AgentTestResult, ChatAgentSummary } from '../lib/chat-types';

export function AgentsPage() {
  const { data, loading, error, refetch } = useChatAgents();
  const navigate = useNavigate();
  const { toast, showToast, dismissToast } = useToast();
  const [deleteTarget, setDeleteTarget] = useState<ChatAgentSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [testById, setTestById] = useState<
    Record<string, AgentTestResult | 'loading'>
  >({});

  if (loading) return <LoadingState label="Loading agents…" />;
  if (error) {
    return (
      <ErrorState
        title="Could not load agents"
        error={error}
        action={
          <button type="button" onClick={() => void refetch()} className="rounded border px-3 py-1 text-sm">
            Retry
          </button>
        }
      />
    );
  }

  async function handleDelete(): Promise<void> {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteChatAgent(deleteTarget.id);
      setDeleteTarget(null);
      showToast(`Deleted ${deleteTarget.id}`, 'success');
      await refetch();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }

  async function handleTest(agent: ChatAgentSummary): Promise<void> {
    setTestById((prev) => ({ ...prev, [agent.id]: 'loading' }));
    try {
      const result = await testChatAgent(agent.id);
      setTestById((prev) => ({ ...prev, [agent.id]: result }));
    } catch (err) {
      setTestById((prev) => ({
        ...prev,
        [agent.id]: {
          ok: false,
          reply: null,
          stopReason: null,
          model: null,
          mode: null,
          effort: null,
          profileErrors: [],
          durationMs: 0,
          error: err instanceof Error ? err.message : 'Test failed',
        },
      }));
    }
  }

  const agents = data?.agents ?? [];
  const parseErrors = data?.errors ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Bot className="h-6 w-6" />
            Agents
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Edit agent definitions in <code className="font-mono">~/.syntaur/agents/&lt;id&gt;.md</code>.
            Model and effort choices come from each harness adapter.
          </p>
        </div>
        <Link to="/agents/new" className="shell-action shell-action--cta">
          <Plus className="h-4 w-4" />
          New agent
        </Link>
      </div>

      {parseErrors.length > 0 ? (
        <ul className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          {parseErrors.map((entry) => (
            <li key={entry}>{entry}</li>
          ))}
        </ul>
      ) : null}

      {agents.length === 0 ? (
        <EmptyState
          title="No agents yet"
          description="Create one above, or add a file under ~/.syntaur/agents/."
        />
      ) : (
        <div className="grid gap-2">
          {agents.map((agent) => (
            <AgentListRow
              key={agent.id}
              agent={agent}
              testResult={testById[agent.id] ?? null}
              onEdit={() => navigate(`/agents/${agent.id}/edit`)}
              onTest={() => void handleTest(agent)}
              onDelete={() => {
                setDeleteError(null);
                setDeleteTarget(agent);
              }}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`Delete ${deleteTarget?.id ?? 'agent'}?`}
        description={
          deleteTarget?.overridesBuiltin
            ? 'This removes the override file and restores the built-in definition.'
            : 'This permanently deletes the agent definition file.'
        }
        confirmLabel="Delete"
        destructive
        loading={deleting}
        error={deleteError}
        onConfirm={handleDelete}
        onOpenChange={(open) => {
          if (!deleting && !open) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      />

      <Toaster toast={toast} onDismiss={dismissToast} />
    </div>
  );
}
