import type { StageId } from '../ticket-templates/manifest.js';
import { STAGE_ORDER } from '../ticket-templates/stages.js';

export type TicketStatus = StageId | 'dropped';

export type TransitionCommand = string;

export const DEFAULT_STATUSES = STAGE_ORDER;

export const VERBS = [
  'plan',
  'approve',
  'unapprove',
  'start',
  'review',
  'done',
  'drop',
  'reopen',
  'block',
  'unblock',
  'park',
  'unpark',
] as const;

export type Verb = (typeof VERBS)[number];

export const DEFAULT_COMMANDS = VERBS;

export const TERMINAL_STAGES: ReadonlySet<TicketStatus> = new Set(['done', 'dropped']);

/** @deprecated Use {@link TERMINAL_STAGES}. */
export const DEFAULT_TERMINAL_STATUSES = TERMINAL_STAGES;

/** @deprecated Use {@link TERMINAL_STAGES}. */
export const TERMINAL_STATUSES: ReadonlySet<string> = TERMINAL_STAGES;

/** Plan role approval state on ticket.md (v2 frontmatter `plan:` block). */
export interface PlanBlock {
  file: string | null;
  approvedDigest: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
}

export interface Workspace {
  repository: string | null;
  worktree: string | null;
  branch: string | null;
  parentBranch: string | null;
}

/** Spec §3 — 17 top-level ticket frontmatter fields. */
export interface TicketFrontmatter {
  id: string;
  slug: string;
  title: string;
  project: string | null;
  template: string | null;
  status: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  blocked: string | null;
  parked: string | null;
  depends_on: string[];
  assignee: string | null;
  tags: string[];
  links: string[];
  workspace: Workspace;
  plan: PlanBlock;
  created: string;
  updated: string;
}

export interface TransitionResult {
  success: boolean;
  message: string;
  fromStatus: string;
  toStatus?: string;
  warnings?: string[];
}
