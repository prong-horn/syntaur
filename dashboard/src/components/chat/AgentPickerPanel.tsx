import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { agentColorClasses } from '../../lib/chat-format';
import { cn } from '../../lib/utils';
import type { ChatAgentSummary, Participants } from '../../lib/chat-types';

/**
 * Attach agents to this ticket, pick the default, and set the hop budget —
 * the three things `chat/participants.json` holds (Decision 1).
 *
 * Everything else a definition declares (harness, model, mode, `respondsTo`) is
 * shown READ-ONLY with the file it comes from: those live in
 * `~/.syntaur/agents/<id>.md`, not in the participants file, and editing them
 * here would write to the wrong place (plan review round 1, finding 11).
 */

const MIN_HOP_BUDGET = 1;
const MAX_HOP_BUDGET = 10;

export interface AgentPickerPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: ChatAgentSummary[];
  participants: Participants | null;
  onSave: (next: Participants) => Promise<void>;
}

export function AgentPickerPanel({
  open,
  onOpenChange,
  agents,
  participants,
  onSave,
}: AgentPickerPanelProps) {
  const [attached, setAttached] = useState<string[]>([]);
  const [defaultAgent, setDefaultAgent] = useState<string | null>(null);
  const [hopBudget, setHopBudget] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed from the server every time the dialog opens, so a change made in
  // another tab is not silently overwritten by a stale draft.
  useEffect(() => {
    if (!open) return;
    setAttached(participants?.agents ?? []);
    setDefaultAgent(participants?.defaultAgent ?? null);
    setHopBudget(participants?.hopBudget === undefined ? '' : String(participants.hopBudget));
    setError(null);
  }, [open, participants]);

  function toggle(id: string): void {
    setAttached((prev) => {
      if (prev.includes(id)) {
        const next = prev.filter((existing) => existing !== id);
        // Detaching the default leaves the chat with nothing to answer an
        // unmentioned message, so the next attached agent takes over.
        if (defaultAgent === id) setDefaultAgent(next[0] ?? null);
        return next;
      }
      if (defaultAgent === null) setDefaultAgent(id);
      return [...prev, id];
    });
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const parsed = hopBudget.trim() === '' ? undefined : Number(hopBudget);
      if (
        parsed !== undefined &&
        (!Number.isInteger(parsed) || parsed < MIN_HOP_BUDGET || parsed > MAX_HOP_BUDGET)
      ) {
        throw new Error(`Hop budget must be a whole number between ${MIN_HOP_BUDGET} and ${MAX_HOP_BUDGET}`);
      }
      await onSave({
        agents: attached,
        defaultAgent,
        ...(parsed === undefined ? {} : { hopBudget: parsed }),
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Agents in this chat</DialogTitle>
          <DialogDescription>
            Attach the agents that can be messaged here and pick the one that answers a message with
            no <code className="font-mono">@mention</code>. Harness, model, mode and reply policy come
            from each agent&rsquo;s definition —{' '}
            <Link to="/library/agents" className="text-primary underline">
              edit them on the Agents page
            </Link>
            .
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[50vh] space-y-2 overflow-y-auto">
          {agents.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No agent definitions found. Add one at{' '}
              <code className="font-mono">~/.syntaur/agents/&lt;id&gt;.md</code>.
            </p>
          )}
          {agents.map((agent) => {
            const isAttached = attached.includes(agent.id);
            return (
              <div
                key={agent.id}
                className={cn(
                  'rounded-md border px-3 py-2',
                  isAttached ? 'border-border bg-muted/20' : 'border-border/50 opacity-70',
                )}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id={`attach-${agent.id}`}
                    checked={isAttached}
                    onChange={() => toggle(agent.id)}
                    className="h-4 w-4"
                  />
                  <span
                    className={cn(
                      'flex h-6 w-6 items-center justify-center rounded text-[11px] font-medium',
                      agentColorClasses(agent.color),
                    )}
                    aria-hidden
                  >
                    {agent.avatar}
                  </span>
                  <label htmlFor={`attach-${agent.id}`} className="text-sm font-medium">
                    {agent.name}
                  </label>
                  <span className="font-mono text-[11px] text-muted-foreground">@{agent.id}</span>
                  <Link
                    to={`/library/agents/${encodeURIComponent(agent.id)}/edit`}
                    className="text-[11px] text-primary underline"
                  >
                    edit
                  </Link>
                  <span className="flex-1" />
                  <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <input
                      type="radio"
                      name="default-agent"
                      checked={defaultAgent === agent.id}
                      disabled={!isAttached}
                      onChange={() => setDefaultAgent(agent.id)}
                      className="h-3 w-3"
                    />
                    default
                  </label>
                </div>
                <div className="mt-1 pl-6 text-[11px] text-muted-foreground">
                  {[
                    agent.harness,
                    agent.model ?? 'inherited model',
                    agent.mode ?? 'inherited mode',
                    `responds to ${agent.respondsTo}`,
                  ].join(' · ')}
                  {agent.description ? ` — ${agent.description}` : ''}
                </div>
                <div className="pl-6 font-mono text-[10px] text-muted-foreground/70">
                  {agent.source ?? 'built in'}
                </div>
                {agent.missing && (
                  <div className="mt-1 pl-6 text-[11px] text-amber-600 dark:text-amber-400">
                    {agent.harness} is not on PATH — install it with{' '}
                    <code className="font-mono">{agent.missing}</code>.
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <label htmlFor="hop-budget">Hop budget</label>
          <input
            id="hop-budget"
            type="number"
            min={MIN_HOP_BUDGET}
            max={MAX_HOP_BUDGET}
            value={hopBudget}
            placeholder="4"
            onChange={(event) => setHopBudget(event.target.value)}
            className="w-16 rounded-md border border-border bg-background px-2 py-1 text-xs"
          />
          <span>agent-to-agent hops per chain before Syntaur stops it.</span>
        </div>

        {error && <p className="text-xs text-rose-500">{error}</p>}

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
