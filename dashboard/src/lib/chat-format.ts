/**
 * Pure formatting for the Chat tab. Kept out of the components so it unit-tests
 * under the node-env dashboard vitest config, the same split the reducer uses.
 */

import type { AgentWorkItem, ChatItem, ToolKind, WorkSummary } from './chat-types';

/** "2m 14s" / "820ms" / "1h 03m". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/** "41.2k" — token counts are scanned, not read. */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(2).replace(/\.00$/, '')}M`;
}

/**
 * "$0.19". Sub-cent turns still deserve a number rather than "$0.00", and a
 * missing cost is empty rather than zero — codex reports none until OpenAI rates
 * land in MODEL_PRICING.
 */
export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return '';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** "Worked 2m 14s · read 9 · edited 3 · ran 2 ✓" (§5.3). */
export function summarizeWork(summary: WorkSummary): string {
  const parts: string[] = [];
  const duration = formatDuration(summary.durationMs);
  parts.push(duration ? `Worked ${duration}` : 'Worked');
  if (summary.reads > 0) parts.push(`read ${summary.reads}`);
  if (summary.edits > 0) parts.push(`edited ${summary.edits}`);
  if (summary.runs > 0) parts.push(`ran ${summary.runs}`);
  const tail = summary.failed > 0 ? `${summary.failed} failed` : '';
  return tail ? `${parts.join(' · ')} · ${tail}` : parts.join(' · ');
}

/** True while any row in the card is still running. */
export function workInProgress(item: AgentWorkItem): boolean {
  return !item.sealed || item.tools.some((t) => t.status === 'running');
}

/** A lucide icon name per tool kind — the classifier Buzz's Activity panel uses. */
export function toolIconName(kind: ToolKind): string {
  switch (kind) {
    case 'read':
      return 'FileText';
    case 'edit':
      return 'FilePen';
    case 'delete':
      return 'Trash2';
    case 'move':
      return 'FolderInput';
    case 'search':
      return 'Search';
    case 'execute':
      return 'Terminal';
    case 'think':
      return 'Brain';
    case 'fetch':
      return 'Globe';
    case 'switch_mode':
      return 'ToggleLeft';
    default:
      return 'Wrench';
  }
}

/** A one-line label for a tool row's locations. */
export function formatLocations(locations: Array<{ path: string; line?: number | null }>): string {
  if (locations.length === 0) return '';
  const first = locations[0];
  const name = first.path.split('/').pop() ?? first.path;
  const suffix = first.line ? `:${first.line}` : '';
  const more = locations.length > 1 ? ` +${locations.length - 1}` : '';
  return `${name}${suffix}${more}`;
}

/**
 * A plan is pinned above the composer while its turn runs and drops back inline
 * once that turn ends — so the checklist stays visible exactly while it is being
 * worked.
 */
export function pinnedPlan(items: ChatItem[]): ChatItem | null {
  const runningTurns = new Set(
    items.filter((i) => i.type === 'turn.status' && i.state === 'running').map((i) => i.turnId),
  );
  if (runningTurns.size === 0) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type === 'agent.plan' && item.turnId && runningTurns.has(item.turnId)) return item;
  }
  return null;
}

/** Permission buttons in a fixed order, whatever order the adapter offered. */
export const PERMISSION_KIND_ORDER = ['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const;

export function orderPermissionOptions<T extends { kind: string }>(options: T[]): T[] {
  const rank = (kind: string) => {
    const at = (PERMISSION_KIND_ORDER as readonly string[]).indexOf(kind);
    return at === -1 ? PERMISSION_KIND_ORDER.length : at;
  };
  return [...options].sort((a, b) => rank(a.kind) - rank(b.kind));
}

/** The allow option Syntaur picks when auto-answering (Decision 3). */
export function preferredAllowOption<T extends { kind: string; optionId: string }>(options: T[]): T {
  return (
    options.find((o) => o.kind === 'allow_once') ??
    options.find((o) => o.kind === 'allow_always') ??
    options[0] ??
    ({ kind: 'allow_once', optionId: 'allow' } as T)
  );
}

/** Primary / secondary / destructive, from the option kind. */
export function permissionButtonTone(kind: string): 'primary' | 'secondary' | 'destructive' {
  if (kind === 'allow_once') return 'primary';
  if (kind === 'allow_always') return 'secondary';
  return 'destructive';
}

/** A short "Claude · 3m 02s · 41.2k · $0.19 · end_turn" line for a turn. */
export function summarizeTurn(input: {
  agentName: string;
  durationMs?: number;
  totalTokens?: number | null;
  cost?: number | null;
  stopReason?: string;
}): string {
  const parts = [input.agentName];
  const duration = formatDuration(input.durationMs);
  if (duration) parts.push(duration);
  const tokens = formatTokens(input.totalTokens);
  if (tokens) parts.push(`${tokens} tokens`);
  const cost = formatCost(input.cost);
  if (cost) parts.push(cost);
  if (input.stopReason && input.stopReason !== 'end_turn') parts.push(input.stopReason);
  return parts.join(' · ');
}

/** Tailwind classes for an agent's colour chip; unknown colours fall back. */
export function agentColorClasses(color: string): string {
  switch (color) {
    case 'violet':
      return 'bg-violet-500/15 text-violet-600 dark:text-violet-400';
    case 'emerald':
      return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400';
    case 'amber':
      return 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
    case 'sky':
      return 'bg-sky-500/15 text-sky-600 dark:text-sky-400';
    case 'rose':
      return 'bg-rose-500/15 text-rose-600 dark:text-rose-400';
    case 'slate':
      return 'bg-muted text-muted-foreground';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

// --- the chat / activity split (Decision 5) --------------------------------

export interface TurnActivity {
  thoughts: ChatItem[];
  work: ChatItem[];
  /** Tool rows across the turn's work cards — what the disclosure expands to. */
  toolCount: number;
}

/**
 * Group a turn's thoughts and work cards by `turnId`. Presentation only: no
 * event, item or index changes, so the split can be tuned without touching
 * persistence (Decision 5).
 */
export function groupByTurn(items: readonly ChatItem[]): Map<string, TurnActivity> {
  const groups = new Map<string, TurnActivity>();
  for (const item of items) {
    if (!item.turnId) continue;
    if (item.type !== 'agent.thought' && item.type !== 'agent.work') continue;
    let group = groups.get(item.turnId);
    if (!group) {
      group = { thoughts: [], work: [], toolCount: 0 };
      groups.set(item.turnId, group);
    }
    if (item.type === 'agent.thought') group.thoughts.push(item);
    else {
      group.work.push(item);
      group.toolCount += item.tools.length;
    }
  }
  return groups;
}

/** "2 thoughts · 5 tool calls", or empty when the turn produced neither. */
export function activitySummary(activity: TurnActivity): string {
  const parts: string[] = [];
  if (activity.thoughts.length > 0) {
    parts.push(`${activity.thoughts.length} thought${activity.thoughts.length === 1 ? '' : 's'}`);
  }
  if (activity.toolCount > 0) {
    parts.push(`${activity.toolCount} tool call${activity.toolCount === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

/**
 * What belongs in the chat column. Everything but a thought: work cards stay,
 * collapsed to their header line, and their full tool rows are reachable from
 * the turn's Activity disclosure.
 */
export function isChatColumnItem(item: Pick<ChatItem, 'type'>): boolean {
  return item.type !== 'agent.thought';
}

/**
 * Rank `@agent` suggestions for a typed partial: prefix matches first, then
 * substring, both case-insensitive. Same shape as the launch-prompt ranking,
 * without its reserved tokens — the candidates here are the attached agents.
 */
export function rankAgentTokens(partial: string, ids: readonly string[]): string[] {
  const p = partial.toLowerCase();
  if (p === '') return [...ids];
  const prefix: string[] = [];
  const substring: string[] = [];
  for (const id of ids) {
    const lower = id.toLowerCase();
    if (lower.startsWith(p)) prefix.push(id);
    else if (lower.includes(p)) substring.push(id);
  }
  return [...prefix, ...substring];
}
