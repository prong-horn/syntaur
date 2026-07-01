import { useState } from 'react';
import { Bot, Plus, Trash2, RefreshCw, Sparkles, FolderPlus } from 'lucide-react';
import {
  useAgentsConfig,
  useDiscoveredAgents,
  registerAgent,
  manualAddAgent,
  createAgent,
  saveAgentsConfig,
  type DiscoveredCandidate,
} from '../hooks/useAgentsConfig';
import type { AgentConfig, RunnerKind } from '@shared/agents-schema';
import { AgentTypeBadge } from '../components/AgentTypeBadge';
import { useToast, Toaster } from '../components/Toast';

const SOURCE_LABEL: Record<DiscoveredCandidate['source'], string> = {
  'claude-global': 'Claude · global',
  'claude-project': 'Claude · project',
  directory: 'Directory',
};

/**
 * The unified agent library surface. Everyday agent UX: browse the flat list
 * (badged by runner), register discovered candidates, manually add a missed
 * path, or author a brand-new def. Launch onto work happens via the badged
 * OpenInAgentButton on assignments/sessions; standalone launch is the CLI
 * (`syntaur agents launch <id>`).
 */
export function AgentsPage() {
  const { agents } = useAgentsConfig();
  const { candidates, loading: discovering, reload } = useDiscoveredAgents(null);
  const { toast, showToast, dismissToast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [manualPath, setManualPath] = useState('');

  const pending = candidates.filter((c) => !c.alreadyRegistered);

  async function handleRemove(agent: AgentConfig): Promise<void> {
    setBusy(agent.id);
    try {
      await saveAgentsConfig(agents.filter((a) => a.id !== agent.id));
      showToast(`Removed "${agent.label}" — its def stays on disk`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Remove failed', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function handleRegister(c: DiscoveredCandidate): Promise<void> {
    setBusy(c.path);
    try {
      await registerAgent({
        path: c.path,
        name: c.name,
        runner: c.runner,
        sourceKind: c.source,
        description: c.description,
      });
      showToast(`Registered "${c.name}"`, 'success');
      reload();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Register failed', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function handleManualAdd(): Promise<void> {
    const path = manualPath.trim();
    if (!path) return;
    setBusy('manual');
    try {
      await manualAddAgent(path);
      showToast(`Added agent from ${path}`, 'success');
      setManualPath('');
      reload();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Manual add failed', 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8 py-2">
      <header className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Bot className="mt-1 size-6 text-primary" />
          <div>
            <h1 className="text-xl font-semibold text-foreground">Agents</h1>
            <p className="text-sm text-muted-foreground">
              One flat library of agents — claude, pi, and codex. Register what
              Syntaur discovers, add a missed path, or author a new one.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          className="shell-action shrink-0"
        >
          <Sparkles className="size-3.5" />
          <span>{showCreate ? 'Close' : 'Create agent'}</span>
        </button>
      </header>

      {showCreate && (
        <CreateAgentForm
          onCreated={(name) => {
            setShowCreate(false);
            showToast(`Created "${name}"`, 'success');
            reload();
          }}
          onError={(msg) => showToast(msg, 'error')}
        />
      )}

      {/* Registered agents */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Registered ({agents.length})
        </h2>
        <ul className="space-y-2">
          {agents.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-3 rounded-md border border-border/60 bg-card px-3 py-2"
            >
              <AgentTypeBadge agent={a} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-foreground">{a.label}</span>
                  {a.default && (
                    <span className="text-[10px] text-muted-foreground/60">default</span>
                  )}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  <code>{a.id}</code>
                  {a.sourcePath ? ` · ${a.sourcePath}` : ` · ${a.command}`}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void handleRemove(a)}
                disabled={busy === a.id}
                title="Remove from the library (leaves the on-disk def alone)"
                className="shell-action px-2 py-1 text-xs text-muted-foreground hover:text-error-foreground disabled:opacity-50"
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* Discovered — click to register */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Discovered ({pending.length})
          </h2>
          <button
            type="button"
            onClick={reload}
            disabled={discovering}
            className="shell-action px-2 py-1 text-xs"
            title="Re-scan"
          >
            <RefreshCw className={`size-3.5 ${discovering ? 'animate-spin' : ''}`} />
            <span>Rescan</span>
          </button>
        </div>
        {discovering ? (
          <p className="text-sm text-muted-foreground">Scanning…</p>
        ) : pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing new to register. Adjust discovery sources in Settings → Agents,
            or add a path below.
          </p>
        ) : (
          <ul className="space-y-2">
            {pending.map((c) => (
              <li
                key={`${c.source}:${c.path}`}
                className="flex items-center gap-3 rounded-md border border-border/60 bg-card px-3 py-2"
              >
                <AgentTypeBadge runner={c.runner} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-foreground">{c.name}</span>
                    {c.recommended && (
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        recommended
                      </span>
                    )}
                    <span className="text-[10px] text-muted-foreground/70">
                      {SOURCE_LABEL[c.source]}
                    </span>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {c.description ? `${c.description} · ` : ''}
                    {c.path}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRegister(c)}
                  disabled={busy === c.path}
                  className="shell-action px-2 py-1 text-xs disabled:opacity-50"
                >
                  <Plus className="size-3.5" />
                  <span>Register</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Manual add */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Add by path
        </h2>
        <p className="text-xs text-muted-foreground">
          Point at a Claude agent <code>.md</code> or an agent directory the scan
          missed (including a bare <code>AGENTS.md</code> folder).
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleManualAdd();
            }}
            placeholder="~/agents/my-bot  or  ~/.claude/agents/foo.md"
            className="flex-1 rounded-md border border-border/70 bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/60"
          />
          <button
            type="button"
            onClick={() => void handleManualAdd()}
            disabled={busy === 'manual' || !manualPath.trim()}
            className="shell-action disabled:opacity-50"
          >
            <FolderPlus className="size-3.5" />
            <span>Add</span>
          </button>
        </div>
      </section>

      <Toaster toast={toast} onDismiss={dismissToast} />
    </div>
  );
}

const RUNNERS: RunnerKind[] = ['claude', 'pi', 'codex'];

function CreateAgentForm({
  onCreated,
  onError,
}: {
  onCreated: (name: string) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [runner, setRunner] = useState<RunnerKind>('claude');
  const [model, setModel] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [location, setLocation] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(): Promise<void> {
    if (!name.trim() || !instructions.trim()) {
      onError('Name and instructions are required');
      return;
    }
    setSubmitting(true);
    try {
      await createAgent({
        name: name.trim(),
        runner,
        model: model.trim() || undefined,
        description: description.trim() || undefined,
        instructions,
        location: location.trim() || undefined,
      });
      onCreated(name.trim());
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setSubmitting(false);
    }
  }

  const field = 'rounded-md border border-border/70 bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/60';

  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-card p-4">
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Name
          <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Researcher" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Type
          <select className={field} value={runner} onChange={(e) => setRunner(e.target.value as RunnerKind)}>
            {RUNNERS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Model <span className="text-muted-foreground/50">(optional)</span>
          <input className={field} value={model} onChange={(e) => setModel(e.target.value)} placeholder="opus" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Location <span className="text-muted-foreground/50">(optional)</span>
          <input
            className={field}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder={runner === 'claude' ? '~/.claude/agents' : '~ (parent dir)'}
          />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Description <span className="text-muted-foreground/50">(optional)</span>
        <input className={field} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Instructions
        <textarea
          className={`${field} min-h-[120px] font-mono`}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="You are a meticulous researcher…"
        />
      </label>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting || !name.trim() || !instructions.trim()}
          className="shell-action disabled:opacity-50"
        >
          <Sparkles className="size-3.5" />
          <span>{submitting ? 'Creating…' : 'Create & register'}</span>
        </button>
      </div>
    </div>
  );
}
