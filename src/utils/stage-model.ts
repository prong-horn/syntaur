/**
 * Browser-safe stage-model types (Phase 1 stage engine, WS-0).
 *
 * The successor to the ladder/`StatusConfig` model: a workflow declares an
 * ordered list of STAGES, each answering *who works it / what must be true to
 * leave / where it goes next*. Stored per-file as `~/.syntaur/workflows/<id>.md`
 * yaml (parsed by `workflow-file.ts`, loaded by `workflow-library.ts`).
 *
 * Like `derive-config.ts`, this module has ZERO imports so the dashboard client
 * can alias it (`@shared/stage-model`) and reuse the exact same shape the server
 * and `doctor` run — client/server/doctor parity, no Node in the browser bundle.
 * `config.ts` re-exports everything here so Node-side `config.js` imports resolve.
 *
 * **No silent deletion.** Every struct carries an optional `raw` passthrough for
 * keys not mapped to a typed field, so an unrecognized (future / misspelled) key
 * round-trips through parse→serialize and `doctor` can flag it, rather than being
 * dropped on the floor (the bug class this model exists to prevent).
 *
 * @see the design authority §2.2 (stage shape) for the authored example.
 */

/** The four route triggers (design §2.3). `on:` defaults to `gate` when absent. */
export const ROUTE_TRIGGERS = ['gate', 'work-start', 'manual'] as const;
export type RouteTrigger = (typeof ROUTE_TRIGGERS)[number];

/**
 * One gate condition. `check` names a computed or judged predicate; `condition`
 * is the raw-AQL escape hatch (mutually exclusive with a computed `check` in
 * practice, but both are preserved if authored). The `by:`/`judge:`/`binds:`/
 * `quorum:` qualifiers are PARSED + preserved in Phase 1 but treated as
 * satisfied-by-any-valid-attestation until Phase 3 wires the provenance resolver
 * (parent-plan decision #7). `not:` holds a verdict-export name (holds during
 * rework).
 */
export interface StageCheck {
  /** The computed/judged predicate name (e.g. `hasRealObjective`, `codeReviewed`). */
  check: string;
  /** Verdict-export gate condition — holds while a `<name>ChangesRequested` verdict stands. */
  not?: string;
  /** Who must render a judged check. Phase-1 advisory (not identity-enforced). */
  by?: 'human' | 'any' | 'not-author' | string;
  /** Named judge role for a judged check. */
  judge?: string;
  /** Revision binding — a judged attestation is bound to a `commit`/`plan` revision. */
  binds?: 'commit' | 'plan' | string;
  /** Minimum number of concurring judged attestations (Phase-4a fan-out; parsed now). */
  quorum?: number;
  /** Raw-AQL escape hatch, e.g. `"acRealTotal > 0"`. */
  condition?: string;
  /** Unrecognized keys, preserved verbatim (no silent deletion). */
  raw?: Record<string, unknown>;
}

/** A declared route out of a stage. `on` defaults to `'gate'` (auto-advance). */
export interface StageRoute {
  /** Target stage id. */
  to: string;
  /** Trigger kind; absent → `'gate'`. Preserved verbatim if an unknown value is authored. */
  on?: RouteTrigger;
  /** Work-start verb discriminator (WS-3, decision 4): meaningful only on
   * `on: work-start` routes. A route WITH a verb matches only a work-start move
   * carrying the same verb (`implement` / `request-review` / `rework`); a route
   * WITHOUT one keeps the match-any behavior (verb-less/legacy workflows are
   * unaffected). The parser flags a `verb:` on a non-work-start route. */
  verb?: string;
  /** Unrecognized keys, preserved verbatim (no silent deletion). */
  raw?: Record<string, unknown>;
}

/**
 * Who works a stage. Parsed + preserved in Phase 1; consumed by the launcher in
 * Phase 3. Unknown keys survive on `raw` so P3 need not re-migrate.
 */
export interface StageWork {
  /** Agent id / kind that works this stage. */
  agent?: string;
  /** Playbooks the agent must load for this stage. */
  playbooks?: string[];
  /** Override launch prompt for this stage. */
  launchPrompt?: string;
  /** Unrecognized keys, preserved verbatim (no silent deletion). */
  raw?: Record<string, unknown>;
}

/** One stage in a workflow. `id` is the stored `status:` value for a ticket here. */
export interface WorkflowStage {
  id: string;
  label?: string;
  color?: string;
  /** Human next-action guidance (successor of the ladder's `next:` label). */
  guidance?: string;
  work?: StageWork;
  /** Artifact this stage produces (rendered; consumed in a later phase). */
  deliverable?: string;
  /** Conditions that must ALL hold to leave via an `on: gate` route. */
  gate?: StageCheck[];
  /** Declared routes out of this stage. */
  next?: StageRoute[];
  /** One-shot route target on a valid dissent verdict (edge-triggered). */
  onDissent?: string;
  /** Terminal stage — arrival runs terminal hooks; no routes out. */
  terminal?: boolean;
  /** Reopen target for a terminal stage (re-placed via the placement function). */
  reopen?: string;
  /** Unrecognized keys, preserved verbatim (no silent deletion). */
  raw?: Record<string, unknown>;
}

/** One orthogonal flag definition — a badge, never a stage/column. */
export interface WorkflowFlag {
  /** AQL condition that raises the flag (absent → manual per-ticket toggle, e.g. `hold`). */
  when?: string;
  /** Unrecognized keys, preserved verbatim (no silent deletion). */
  raw?: Record<string, unknown>;
}

/**
 * Orthogonal flags. `blocked`/`parked`/`hold` are the built-in trio; the index
 * signature keeps any custom flag name losslessly (no silent deletion).
 */
export interface WorkflowFlags {
  blocked?: WorkflowFlag;
  parked?: WorkflowFlag;
  hold?: WorkflowFlag;
  [flag: string]: WorkflowFlag | undefined;
}

/** A complete per-file workflow (design §2.2). */
export interface StageWorkflow {
  id: string;
  label?: string;
  stages: WorkflowStage[];
  flags?: WorkflowFlags;
  /** The `syntaur fail` target — a terminal failure stage id. */
  terminalFailure?: string;
  /** Whether this workflow's tickets require a git workspace. */
  workspace?: 'git' | 'none';
  /** Unrecognized top-level keys, preserved verbatim (no silent deletion). */
  raw?: Record<string, unknown>;
}
