import { useState } from 'react';
import { CalendarClock, Plus, Ban } from 'lucide-react';
import { useSchedules } from '../hooks/useSchedules';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { CreateScheduleDialog } from '../components/CreateScheduleDialog';
import { cancelSchedule, describeTrigger, type Schedule } from '../lib/schedules';

const TERMINAL_STATES = new Set(['completed', 'failed', 'launch_failed', 'cancelled', 'killed']);

function stateClass(state: string): string {
  if (state === 'running') return 'bg-green-500/15 text-green-400 border-green-500/30';
  if (state === 'eligible') return 'bg-blue-500/15 text-blue-400 border-blue-500/30';
  if (state === 'held') return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
  if (state === 'launch_failed' || state === 'failed' || state === 'killed') return 'bg-red-500/15 text-red-400 border-red-500/30';
  return 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30';
}

export function SchedulesPage() {
  const { data, loading, error, refetch } = useSchedules();
  const [creating, setCreating] = useState(false);

  if (loading) return <LoadingState label="Loading schedules…" />;
  if (error) {
    return (
      <ErrorState
        title="Could not load schedules"
        error={error}
        action={<button type="button" onClick={refetch} className="rounded border px-3 py-1 text-sm">Retry</button>}
      />
    );
  }

  async function handleCancel(job: Schedule): Promise<void> {
    try {
      await cancelSchedule(job.id);
      refetch();
    } catch (err) {
      window.alert(err instanceof Error ? `Cancel failed: ${err.message}` : 'Cancel failed');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Schedules</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Run work on an assignment unattended — on a clock, after a quota reset, or when an assignment reaches a status.
            The scheduler tick is the sole authority; this page calls the same CLI verbs.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground"
        >
          <Plus className="h-4 w-4" />
          New schedule
        </button>
      </div>

      {!data || data.length === 0 ? (
        <EmptyState
          title="No schedules yet"
          description="Create one above, or with `syntaur schedule create --assignment <id> --cron '0 3 * * *'`."
        />
      ) : (
        <div className="grid gap-2">
          {data.map((job) => (
            <div key={job.id} className="flex items-center justify-between rounded-lg border bg-card p-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <CalendarClock className="h-4 w-4 text-muted-foreground" />
                  <span className="font-mono text-sm">{job.assignmentId}</span>
                  <span className={`rounded border px-1.5 py-0.5 text-xs ${stateClass(job.attempt.state)}`}>{job.attempt.state}</span>
                  {!job.unattended && <span className="text-xs text-muted-foreground">interactive</span>}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {describeTrigger(job.trigger)} · agent <code className="font-mono">{job.agentId}</code>
                  {job.attempt.lastError && <span className="text-destructive"> · {job.attempt.lastError}</span>}
                </div>
              </div>
              {!TERMINAL_STATES.has(job.attempt.state) && (
                <button
                  type="button"
                  onClick={() => handleCancel(job)}
                  className="flex items-center gap-1 rounded border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                >
                  <Ban className="h-3 w-3" />
                  Cancel
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <CreateScheduleDialog open={creating} onOpenChange={setCreating} onCreated={refetch} />
    </div>
  );
}
