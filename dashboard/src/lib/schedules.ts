// SPA-side client + view types for scheduled jobs. The shapes mirror
// `src/schedules/types.ts` (the server source of truth); only the fields the UI
// reads are typed here (the SPA build can't import the server module directly).

export interface ScheduleTrigger {
  kind: 'at' | 'in' | 'cron' | 'after-reset' | 'when-status' | 'when-plan-lands';
  at?: string;
  durationMs?: number;
  anchorIso?: string;
  expr?: string;
  tz?: string;
  provider?: 'claude' | 'codex';
  anchor?: { windowStartIso: string; windowKind: 'rolling-5h' | 'weekly' };
  status?: string;
  assignmentId?: string;
}

export interface Schedule {
  id: string;
  assignmentId: string;
  agentId: string;
  promptTemplate: string | null;
  playbook: string | null;
  terminalPreference: string | null;
  unattended: boolean;
  trigger: ScheduleTrigger;
  attempt: { state: string; sessionId: string | null; lastError: string | null };
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduleInput {
  assignmentId: string;
  agentId: string;
  trigger: ScheduleTrigger;
  unattended: boolean;
  terminalPreference?: string | null;
  promptTemplate?: string | null;
  note?: string | null;
}

export function describeTrigger(t: ScheduleTrigger): string {
  switch (t.kind) {
    case 'at':
      return `at ${t.at}`;
    case 'in':
      return `in ${Math.round((t.durationMs ?? 0) / 1000)}s`;
    case 'cron':
      return `cron ${t.expr}${t.tz ? ` (${t.tz})` : ''}`;
    case 'after-reset':
      return `after ${t.provider} reset`;
    case 'when-status':
      return `when ${t.assignmentId ?? 'this'} → ${t.status}`;
    case 'when-plan-lands':
      return `when ${t.assignmentId ?? 'this'} plan lands`;
    default:
      return t.kind;
  }
}

export async function fetchSchedules(): Promise<Schedule[]> {
  const res = await fetch('/api/schedules');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { schedules: Schedule[] };
  return body.schedules;
}

export async function createSchedule(input: CreateScheduleInput): Promise<Schedule> {
  const res = await fetch('/api/schedules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as { schedule?: Schedule; error?: string } | null;
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body!.schedule!;
}

export async function cancelSchedule(id: string): Promise<void> {
  const res = await fetch(`/api/schedules/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
}
