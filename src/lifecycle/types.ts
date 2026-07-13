// WS-2: the extended `statusHistory` hop fields reference the pure engine's
// shapes. These are `import type` ONLY — `stage-engine.ts` already imports
// `AttestationRecord`/`Solicitation` from here, so a value import back would be
// a runtime cycle; type-only imports erase at compile time (codex r2 finding 8).
import type { HopTrigger, GateSnapshotEntry, DissentCause } from './stage-engine.js';
import type { StageRoute } from '../utils/stage-model.js';

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
  // ── stage-engine hop fields (WS-2) ───────────────────────────────────────
  // Present ONLY on entries the engine writes (one per hop). Absent → a flat
  // ladder/legacy entry, unchanged. `route` is optional because the forced
  // first move of a `manual-override`/`reopen` step has no engine route (a pure
  // `Hop.route` is required; the forced move is written as a bare
  // StatusHistoryEntry, never a `Hop` — codex r4).
  /** The declared route this hop traversed; absent on a forced first move. */
  route?: StageRoute;
  /** How the move was triggered (`gate`/`verdict`/`manual-override`/`reopen`/…). */
  trigger?: HopTrigger;
  /** The gate-passage snapshot at the hop (for regression + audit). */
  gateSnapshot?: GateSnapshotEntry[];
  /** The (check, actor, verdict) that fired a verdict route, if any. */
  dissent?: DissentCause;
}

/**
 * One frozen check state, snapshotted into `frozenChecks` at terminal arrival
 * (design §2.3 AC4). Read verbatim while `disposition: terminal` so worktree
 * cleanup can't retroactively "break" a done ticket's gate. Absent block →
 * `null` (not-yet-terminal / pre-migration).
 */
export interface FrozenCheck {
  key: string;
  label: string;
  passed: boolean;
}

/**
 * One persisted gate-override stamp (design §2.4). Written when a
 * `manual-override` move forces a ticket forward past a FAILING gate — one per
 * crossed failing gate. Carries `label` + the move endpoints so self-clear can
 * match on key AND label (a positional `stage:key` alone is not reorder-safe —
 * codex r2 finding 4). Self-clears on the next recompute where the live gate
 * (matched key+label) passes; a reordered/removed gate is left for the doctor.
 */
export interface GateOverride {
  /** The stage whose gate was overridden. */
  stage: string;
  /** The overridden check's positional key `${stageId}:${index}`. */
  key: string;
  /** The overridden check's human label (reorder-safe self-clear match). */
  label: string;
  /** Move source stage id. */
  from: string;
  /** Move target stage id. */
  to: string;
  /** Who forced the override (audit actor). */
  actor: string;
  /** ISO timestamp of the override. */
  at: string;
  /** Free-text reason (esp. for a backward/off-spine move recorded without a stamp). */
  reason?: string;
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
 * One judgment solicitation (Phase 1 stage engine, WS-1; design §2.5). A
 * request for a qualified actor to render a verdict on a judged gate check,
 * bound to the revision it was opened against. Travels with the ticket
 * (git-tracked, multi-machine-coherent) so "awaiting judgment ⏳" is computable.
 *
 * WS-1 defines the type + its pure evaluation (`evaluateCheckState`, where an
 * open, current solicitation yields the `awaiting` state). WS-2 wires it into
 * `AssignmentFrontmatter` + the parser/serializer on the write path; the
 * dispatcher-driven parts (auto-solicitation, TTL/dead-judge reaping, per-revision
 * fan-out) are Phase 4a (parent-plan decision #8). Currentness (does
 * `revisionBinding` match the live revision?) is evaluated Node-side and passed
 * into the engine, exactly like attestation validity.
 */
export interface Solicitation {
  /** The judged check this solicitation is for. */
  check: string;
  /** Runner profile / judge role solicited (optional; a `by: human` check has none). */
  judge?: string;
  /** The commit sha / plan-digest the solicitation was opened against. */
  revisionBinding?: string;
  /** ISO timestamp the solicitation was opened. */
  at: string;
  /** The launched session (for reaping / attribution). */
  sessionRef?: string;
  /** Lifecycle: solicited (open) → rendered (a verdict landed) | failed (judge died / TTL). */
  state: 'solicited' | 'rendered' | 'failed';
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
  /** Explicit lifecycle-workflow override (`workflow:` id). Null → resolve via
   * project `workflowByType[type]` / project default / global default / `default`. */
  workflow: string | null;
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
  /** Rework requested: a new `implement` stage opened after `review`. Drops the
   * review rung even when ACs stay checked. Asserted by the stage-fact bridge. */
  reworkRequested: boolean;
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
  // ── stage-engine fields (WS-2; dormant until `stages-migrated`) ───────────
  /** Open/rendered judgment solicitations (design §2.5). Absent block → []. */
  solicitations: Solicitation[];
  /** `dissentKey()`s already routed on — edge-trigger bookkeeping so a still-valid
   * dissent doesn't re-route every recompute (WS-1 handoff dep 1). Absent → []. */
  firedVerdicts: string[];
  /** Frozen terminal check snapshot; `null` while non-terminal / pre-migration. */
  frozenChecks: FrozenCheck[] | null;
  /** Per-ticket manual hold (design §2.6) — suspends engine auto-movement.
   * Fed to `EngineInput.held`. Absent → false. */
  hold: boolean;
  /** Persisted gate-override stamps (design §2.4). Absent block → []. */
  gateOverrides: GateOverride[];
}

export interface TransitionResult {
  success: boolean;
  message: string;
  fromStatus: AssignmentStatus;
  toStatus?: AssignmentStatus;
  warnings?: string[];
}
