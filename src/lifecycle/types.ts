export type AssignmentStatus = string;

export type TransitionCommand = string;

export const DEFAULT_STATUSES = [
  'draft',
  'pending',
  'ready_for_planning',
  'ready_to_implement',
  'in_progress',
  'blocked',
  'review',
  'completed',
  'failed',
] as const;

export const DEFAULT_COMMANDS = [
  'start',
  'shape',
  'plan-ready',
  'implement',
  'complete',
  'block',
  'unblock',
  'review',
  'fail',
  'reopen',
  'assign',
] as const;

export const DEFAULT_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
]);

export const TERMINAL_STATUSES: ReadonlySet<string> = DEFAULT_TERMINAL_STATUSES;

export interface ExternalId {
  system: string;
  id: string;
  url: string | null;
}

/**
 * One row in an assignment's `statusHistory` frontmatter array — an append-only
 * log of status transitions. `at`/`from`/`to` are always present (`from` is null
 * only for the creation/seed entry). `command`/`by` are recorded when known;
 * `reason` is set on `block` transitions. See the Query Language design doc,
 * Piece 1, for the full data-model rationale.
 *
 * Dimension-aware extension (derived-status design v3): `from`/`to` ALWAYS hold
 * the headline status. When the underlying phase and/or disposition dimension
 * changed, the optional `phaseFrom/phaseTo` / `dispositionFrom/dispositionTo`
 * keys record it — so a phase change under an unchanged headline (e.g. progress
 * while blocked) is representable as `from: blocked, to: blocked,
 * phaseFrom: planning, phaseTo: ready_to_implement`. Entries written before the
 * dimension model simply lack the keys and parse unchanged.
 */
export interface StatusHistoryEntry {
  at: string;
  from: string | null;
  to: string;
  command: string;
  by: string | null;
  reason?: string;
  phaseFrom?: string | null;
  phaseTo?: string | null;
  dispositionFrom?: string | null;
  dispositionTo?: string | null;
}

/**
 * Revision-bound plan approval record (derived-status design v3, Piece 5).
 * The derived `planApproved` fact is true iff `file` is still the latest plan
 * revision AND `digest` matches its current content — so a replan or a
 * post-approval edit auto-invalidates the approval.
 */
export interface PlanApproval {
  file: string;
  digest: string;
  by: string | null;
  at: string;
}

/**
 * One attestation record (custom-facts-attestations): "agent X reviewed
 * revision Y with verdict Z". One record per (fact, actor) — re-attesting
 * replaces that actor's record. Revision-bound via the binding snapshot:
 * `file`+`digest` for binds:plan (planApproval semantics), `commit` for
 * binds:commit, neither for binds:none. A record is VALID only while its
 * snapshot still matches the live revision; stale records contribute nothing.
 */
export interface AttestationRecord {
  fact: string;
  actor: string;
  verdict: 'approved' | 'changes-requested';
  at: string;
  note?: string;
  /** binds:plan snapshot — plan file name + its digest at attest time. */
  file?: string;
  digest?: string;
  /** binds:commit snapshot — workspace HEAD sha at attest time. */
  commit?: string;
}

/**
 * Sticky manual status override ("pin"). Folded into the written headline
 * `status` at recompute time; the un-overridden derived headline travels in
 * API payloads only (divergence display). May not target a terminal status
 * and may not be applied to a terminal assignment.
 */
export interface StatusOverride {
  status: string;
  source: string; // 'human' | 'agent:<id>'
  reason: string | null;
  at: string;
}

/** Disposition dimension values (orthogonal to phase). */
export const DISPOSITIONS = ['active', 'blocked', 'parked', 'terminal'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export interface Workspace {
  repository: string | null;
  worktreePath: string | null;
  branch: string | null;
  parentBranch: string | null;
}

export interface AssignmentFrontmatter {
  id: string;
  slug: string;
  title: string;
  project: string | null;
  type: string | null;
  status: AssignmentStatus;
  priority: 'low' | 'medium' | 'high' | 'critical';
  created: string;
  updated: string;
  assignee: string | null;
  externalIds: ExternalId[];
  statusHistory: StatusHistoryEntry[];
  dependsOn: string[];
  links: string[];
  blockedReason: string | null;
  workspace: Workspace;
  tags: string[];
  archived: boolean;
  archivedAt: string | null;
  archivedReason: string | null;
  // ── derived-status v3 fields ─────────────────────────────────────────────
  /** Cached phase dimension (written by recompute; null pre-migration). */
  phase: string | null;
  /** Cached disposition dimension (written by recompute; null pre-migration). */
  disposition: string | null;
  /** Revision-bound plan approval record; null = not approved. */
  planApproval: PlanApproval | null;
  /** Intentional withhold → disposition: parked. */
  parked: boolean;
  /** Review escalation atom; feeds the review phase rung. */
  reviewRequested: boolean;
  /** Asserted "implementation has begun" (worktrees precede planning, so workspaceSet ≠ building). */
  implementationStarted: boolean;
  /** Sticky manual pin; null = no override. */
  override: StatusOverride | null;
  /** Custom asserted fact values (raw scalars keyed by declared name; typed
   * coercion against declarations happens in facts.ts). Absent block → {}. */
  facts: Record<string, string>;
  /** Attestation records, one per (fact, actor). Revision-bound; stale records
   * contribute nothing at compute time. Absent block → []. */
  attestations: AttestationRecord[];
}

export interface TransitionResult {
  success: boolean;
  message: string;
  fromStatus: AssignmentStatus;
  toStatus?: AssignmentStatus;
  warnings?: string[];
}
