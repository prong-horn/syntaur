import { useState } from 'react';
import { X } from 'lucide-react';
import {
  createSchedule,
  type ScheduleTrigger,
  type CreateScheduleInput,
} from '../lib/schedules';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

type Kind = ScheduleTrigger['kind'];

const KINDS: Array<{ value: Kind; label: string }> = [
  { value: 'cron', label: 'Cron expression' },
  { value: 'at', label: 'At a timestamp' },
  { value: 'in', label: 'After a delay' },
  { value: 'after-reset', label: 'After quota reset' },
  { value: 'when-status', label: 'When assignment reaches status' },
  { value: 'when-plan-lands', label: 'When plan lands' },
];

export function CreateScheduleDialog({ open, onOpenChange, onCreated }: Props) {
  const [assignmentId, setAssignmentId] = useState('');
  const [agentId, setAgentId] = useState('claude');
  const [kind, setKind] = useState<Kind>('cron');
  const [unattended, setUnattended] = useState(true);
  const [terminal, setTerminal] = useState('');
  const [prompt, setPrompt] = useState('');
  // Trigger params
  const [cronExpr, setCronExpr] = useState('0 3 * * *');
  const [tz, setTz] = useState('');
  const [atTs, setAtTs] = useState('');
  const [inHours, setInHours] = useState('5');
  const [provider, setProvider] = useState<'claude' | 'codex'>('claude');
  const [windowStart, setWindowStart] = useState('');
  const [windowKind, setWindowKind] = useState<'rolling-5h' | 'weekly'>('rolling-5h');
  const [status, setStatus] = useState('ready_to_implement');
  const [watchAssignment, setWatchAssignment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function buildTrigger(): ScheduleTrigger {
    switch (kind) {
      case 'cron':
        return { kind, expr: cronExpr, ...(tz ? { tz } : {}) };
      case 'at':
        return { kind, at: atTs };
      case 'in':
        return { kind, durationMs: Math.round(Number(inHours) * 3_600_000), anchorIso: new Date().toISOString() };
      case 'after-reset':
        return { kind, provider, anchor: { windowStartIso: windowStart || new Date().toISOString(), windowKind } };
      case 'when-status':
        return { kind, status, ...(watchAssignment ? { assignmentId: watchAssignment } : {}) };
      case 'when-plan-lands':
        return { kind, ...(watchAssignment ? { assignmentId: watchAssignment } : {}) };
    }
  }

  async function handleSubmit(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const input: CreateScheduleInput = {
        assignmentId: assignmentId.trim(),
        agentId: agentId.trim(),
        trigger: buildTrigger(),
        unattended,
        terminalPreference: terminal.trim() || null,
        promptTemplate: prompt.trim() || null,
      };
      if (!input.assignmentId) throw new Error('Assignment id is required');
      await createSchedule(input);
      onCreated();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setSubmitting(false);
    }
  }

  const field = 'w-full rounded border bg-background px-2 py-1 text-sm';
  const labelCls = 'block text-xs font-medium text-muted-foreground';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader className="flex-row items-center justify-between space-y-0">
          <DialogTitle>New schedule</DialogTitle>
          <DialogClose
            className="text-muted-foreground transition hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </DialogClose>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label className={labelCls}>Assignment id / slug</label>
            <input className={field} value={assignmentId} onChange={(e) => setAssignmentId(e.target.value)} placeholder="scheduled-agents" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Agent</label>
              <input className={field} value={agentId} onChange={(e) => setAgentId(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Terminal (optional)</label>
              <input className={field} value={terminal} onChange={(e) => setTerminal(e.target.value)} placeholder="default" />
            </div>
          </div>

          <div>
            <label className={labelCls}>Trigger</label>
            <select className={field} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>{k.label}</option>
              ))}
            </select>
          </div>

          {kind === 'cron' && (
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelCls}>Cron expr</label><input className={field} value={cronExpr} onChange={(e) => setCronExpr(e.target.value)} /></div>
              <div><label className={labelCls}>Timezone (optional)</label><input className={field} value={tz} onChange={(e) => setTz(e.target.value)} placeholder="local" /></div>
            </div>
          )}
          {kind === 'at' && (
            <div><label className={labelCls}>ISO timestamp</label><input className={field} value={atTs} onChange={(e) => setAtTs(e.target.value)} placeholder="2026-06-16T03:00:00Z" /></div>
          )}
          {kind === 'in' && (
            <div><label className={labelCls}>Delay (hours)</label><input className={field} type="number" value={inHours} onChange={(e) => setInHours(e.target.value)} /></div>
          )}
          {kind === 'after-reset' && (
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelCls}>Provider</label><select className={field} value={provider} onChange={(e) => setProvider(e.target.value as 'claude' | 'codex')}><option value="claude">claude</option><option value="codex">codex</option></select></div>
              <div><label className={labelCls}>Window kind</label><select className={field} value={windowKind} onChange={(e) => setWindowKind(e.target.value as 'rolling-5h' | 'weekly')}><option value="rolling-5h">rolling-5h</option><option value="weekly">weekly</option></select></div>
              <div className="col-span-2"><label className={labelCls}>Window start (optional ISO)</label><input className={field} value={windowStart} onChange={(e) => setWindowStart(e.target.value)} placeholder="now" /></div>
            </div>
          )}
          {kind === 'when-status' && (
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelCls}>Status</label><input className={field} value={status} onChange={(e) => setStatus(e.target.value)} /></div>
              <div><label className={labelCls}>Watch assignment (optional)</label><input className={field} value={watchAssignment} onChange={(e) => setWatchAssignment(e.target.value)} placeholder="this assignment" /></div>
            </div>
          )}
          {kind === 'when-plan-lands' && (
            <div><label className={labelCls}>Watch assignment (optional)</label><input className={field} value={watchAssignment} onChange={(e) => setWatchAssignment(e.target.value)} placeholder="this assignment" /></div>
          )}

          <div>
            <label className={labelCls}>Prompt template (optional)</label>
            <input className={field} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="plan @assignment" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={unattended} onChange={(e) => setUnattended(e.target.checked)} />
            Unattended (hard limits + kill switch apply)
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={() => onOpenChange(false)} className="rounded border px-3 py-1 text-sm">Cancel</button>
          <button type="button" onClick={handleSubmit} disabled={submitting} className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50">
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
