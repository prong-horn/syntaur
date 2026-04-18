# Syntaur Doctor — `syntaur doctor` + `/doctor-syntaur`

**Date:** 2026-04-17
**Status:** Draft plan (post-codex-review revision)
**Scope:** Diagnostic tool that helps users (and agents) recover from common bad states in Syntaur.

---

## Goal

Provide a two-layer recovery tool:

1. **`syntaur doctor`** — a CLI that runs structured checks against `~/.syntaur/` and the local working copy. Exits 0 on clean, non-zero on issues. Human output by default; `--json` for agent consumption.
2. **`/doctor-syntaur`** — a Claude Code slash command that runs `syntaur doctor --json`, interprets results in-conversation, and offers guided remediation (respecting write boundaries).

Non-goals (for v1):
- No auto-fix that crosses write boundaries.
- No destructive operations without explicit confirmation.
- No new daemon / background monitoring — this is a one-shot, user-invoked tool.
- No PID/heartbeat tracking additions to the session model (drops `dashboard.dead-sessions` and `dashboard.dead-servers` from v1; revisit after session metadata supports it).

---

## Architecture decision: where does each piece live?

| Component | Location | Rationale |
|-----------|----------|-----------|
| Check engine + CLI | `src/commands/doctor.ts` + `src/utils/doctor/` | Source of truth. Works without Claude, scriptable, CI-friendly. |
| Slash command | `platforms/claude-code/commands/doctor-syntaur/doctor-syntaur.md` | Mirrors existing `track-session` / `track-server` layout. |
| Codex equivalent (future) | `platforms/codex/commands/doctor-syntaur/` | Deferred. Same pattern when we get to it. |

**Why not `syntaur-skills`?** The skills repo holds agent-agnostic protocol knowledge. A diagnostic is a CLI tool + a Claude-specific wrapper — it's platform glue, not cross-agent teaching material.

---

## `syntaur doctor` — CLI design

### Usage

```bash
syntaur doctor                    # run all checks, human output
syntaur doctor --json             # structured output for agents
syntaur doctor --fix              # apply safe auto-fixes (opt-in)
syntaur doctor --only <check-id>  # run a single check (for targeted reruns)
syntaur doctor --verbose          # include passing checks in output
```

Exit codes:
- `0` — all checks passed (or only warnings)
- `1` — one or more errors
- `2` — doctor itself failed to run (e.g., `~/.syntaur/` missing entirely)

### JSON schema (stable contract for `/doctor-syntaur`)

```json
{
  "version": "1.0",
  "syntaurVersion": "0.1.14",
  "ranAt": "2026-04-17T12:34:56Z",
  "summary": { "pass": 12, "warn": 2, "error": 1, "skipped": 0 },
  "checks": [
    {
      "id": "assignment.workspace-missing",
      "category": "assignment",
      "title": "Assignment is past planning but has no workspace set",
      "status": "error",
      "detail": "mission foo / assignment bar has status=in_progress but workspace.worktreePath and workspace.repository are both null",
      "affected": ["~/.syntaur/missions/foo/assignments/bar/assignment.md"],
      "remediation": {
        "kind": "manual",
        "suggestion": "Set workspace.repository and workspace.worktreePath in the assignment frontmatter before continuing implementation",
        "command": null
      },
      "autoFixable": false
    }
  ]
}
```

`remediation.kind` ∈ `"manual" | "auto-safe" | "auto-destructive"`. Only `auto-safe` is run under `--fix`. `auto-destructive` is never run without interactive confirmation — and `syntaur doctor` is non-interactive, so those always require manual action (the slash command handles the interactive path).

`CheckResult` and the JSON shape above are the **same type**. See the TS interface in Code Layout — it must include `category`, `title`, `autoFixable` to match.

### Check categories (v1)

Each check has a stable `id` string so the slash command can reference it.

**Environment (`env.*`)**
- `env.syntaur-root-exists` — `~/.syntaur/` exists. (Fail-fast: all other checks skip if this fails.)
- `env.config-valid` — `~/.syntaur/config.md` exists, parses (frontmatter + YAML/JSON body per `src/utils/config.ts`), required fields present.
- `env.cli-version` — installed CLI version matches latest published on npm (warn only; network-dependent, skips if offline).
- `env.node-version` — Node version meets minimum declared in `package.json`.

**Structure (`structure.*`)**

Check only what `init` and code actually create/require. Treat lazily created dirs as `skipped` if absent, not `error`.

- `structure.missions-dir` — `missions/` exists (created by `init`).
- `structure.playbooks-dir` — `playbooks/` exists (created by `init`).
- `structure.todos-dir-valid` — if `todos/` exists, it's readable (lazy-created by `src/todos/parser.ts`; absent is fine).
- `structure.servers-dir-valid` — if `servers/` exists, it's readable (lazy).
- `structure.known-files-recognized` — don't flag `syntaur.db`, `dashboard-port`, `workspaces.json`, `config.md` as orphans.

**Missions (`mission.*`)**

Covers the full scaffold from `src/commands/create-mission.ts`.

- `mission.required-files-present` — each mission has `mission.md`, `manifest.md`, `agent.md`, `claude.md`, `_status.md`, `_index-assignments.md`, `_index-plans.md`, `_index-decisions.md`, `resources/_index.md`, `memories/_index.md`.
- `mission.manifest-stale` — `manifest.md` mtime older than any assignment change (**warn only; no auto-fix in v1** — no mission-rebuild helper exists yet; see Deferred).
- `mission.orphan-files` — unexpected top-level files in a mission directory.

**Assignments (`assignment.*`)**
- `assignment.required-files` — `assignment.md` exists in each `missions/<mission>/assignments/<slug>/` folder.
- `assignment.orphaned-folder` — folder under `assignments/` without `assignment.md`.
- `assignment.invalid-status` — frontmatter `status:` not in the configured `StatusConfig` (or `DEFAULT_STATUSES` if none configured: `pending`, `in_progress`, `blocked`, `review`, `completed`, `failed`).
- `assignment.workspace-missing` — non-terminal status (anything except `completed` / `failed` per `DEFAULT_TERMINAL_STATUSES`) with both `workspace.repository` and `workspace.worktreePath` null. This is the recurring write-boundary-hook trigger — catching it preemptively is the point.
- `assignment.required-files-by-status` — `plan.md` present when status ∈ {`in_progress`, `review`, `completed`}; `handoff.md` present when status ∈ {`review`, `completed`}. (Statuses come from the lifecycle engine; see Open Question below if config has custom statuses.)

**Dashboard DB (`dashboard.*`)**

The "dashboard" for these checks is the SQLite DB at `~/.syntaur/syntaur.db` — authoritative data for agent sessions. Reading it directly avoids depending on the HTTP server being up.

- `dashboard.db-reachable` — DB file exists and is a valid SQLite DB with the `sessions` table. **Error if not**, per resolved decision 1.
- `dashboard.ghost-sessions` — `sessions` rows whose `mission_slug` / `assignment_slug` reference missions or assignments that no longer exist on disk.
- ~~`dashboard.missing-assignments`~~ / ~~`dashboard.ghost-assignments`~~ — **dropped from v1.** These were predicated on the DB containing an assignment index; it doesn't (only `sessions` + `meta` tables). Adding an assignment index is a schema migration deferred to a separate plan.
- ~~`dashboard.dead-sessions`~~ — **dropped from v1.** Session rows (`src/dashboard/types.ts:388`) don't store PID/heartbeat, so liveness can't be determined.
- ~~`dashboard.dead-servers`~~ — **dropped from v1** for symmetry. Reconsider once session model grows runtime metadata.

**Integrations (`integrations.*`)**
- `integrations.claude-plugin-linked` — `config.integrations.claudePluginDir` resolves and the plugin directory exists.
- `integrations.codex-plugin-linked` — same for `codexPluginDir`.
- `integrations.backup-configured` — warn only if `config.backup` is null and the user has ≥ 1 mission (nudge to set up backup).

**Workspace (`workspace.*`)** *(runs only when cwd contains `.syntaur/context.json`)*
- `workspace.context-valid` — `.syntaur/context.json` parses.
- `workspace.context-assignment-resolves` — referenced assignment/mission exists on disk.
- `workspace.context-terminal` — warn if referenced assignment is in a terminal status (`completed` / `failed`).

### Code layout

```
src/
├── commands/
│   └── doctor.ts                 # CLI wiring, flag parsing, output formatting
└── utils/
    └── doctor/
        ├── index.ts              # runChecks(ctx) — orchestrator
        ├── types.ts              # CheckResult, CheckContext, Remediation, Check
        ├── registry.ts           # ordered list of all checks
        ├── context.ts            # buildCheckContext() — reads config, opens syntaur.db read-only
        ├── output-human.ts       # terminal output (no chalk; use ANSI codes or zero deps)
        ├── output-json.ts        # JSON serializer
        └── checks/
            ├── env.ts
            ├── structure.ts
            ├── mission.ts
            ├── assignment.ts
            ├── dashboard.ts
            ├── integrations.ts
            └── workspace.ts
```

```ts
// types.ts
export type Remediation = {
  kind: 'manual' | 'auto-safe' | 'auto-destructive';
  suggestion: string;
  command: string | null;
};

export interface CheckResult {
  id: string;
  category: string;
  title: string;
  status: 'pass' | 'warn' | 'error' | 'skipped';
  detail?: string;
  affected?: string[];
  remediation?: Remediation;
  autoFixable: boolean;
}

export interface CheckContext {
  config: SyntaurConfig;
  syntaurRoot: string;
  db: Database | null;   // null if dashboard.db-reachable failed; downstream checks skip
  cwd: string;
  now: Date;             // injectable for tests
}

export interface Check {
  id: string;
  category: string;
  title: string;
  run(ctx: CheckContext): Promise<CheckResult | CheckResult[]>;
}
```

**Command wiring style:** follow `src/commands/backup.ts` — export `doctorCommand` as a `Command` instance and append it to the program in `src/index.ts`. Match the existing backup-command import pattern.

**No `chalk` dependency.** Use zero-dep ANSI codes for color in `output-human.ts` (existing repo pattern: no `chalk` in `package.json`). If a richer palette becomes necessary later, add it as a separate task.

### Implementation steps

1. **Scaffold types + orchestrator.** Create `src/utils/doctor/types.ts` (types above), `src/utils/doctor/index.ts` (empty `runChecks`), `src/utils/doctor/context.ts` (builds context; opens `syntaur.db` with `better-sqlite3` in read-only mode — reuse `src/dashboard/session-db.ts` initialization pattern), `src/utils/doctor/registry.ts` (empty array).
2. **Implement `env.*` and `structure.*`.** Pure `fs.stat` and config parsing — no DB, no network (except `env.cli-version`, which fetches npm registry; use `fetch` with 2s timeout and degrade to `skipped`).
3. **Implement `mission.*` and `assignment.*`.** Reuse `src/utils/assignment-resolver.ts` (`resolveAssignmentById`, directory walkers) and `src/utils/config.ts` (status config, frontmatter parse). Use `DEFAULT_STATUSES` / `DEFAULT_TERMINAL_STATUSES` from `src/lifecycle/types.ts` when no custom statuses are configured.
4. **Implement `dashboard.*`.** Open `~/.syntaur/syntaur.db` read-only. If open fails, emit `dashboard.db-reachable` as **error** (per resolved decision 1) and mark remaining `dashboard.*` checks as `skipped` with a "skipped because db-reachable failed" note. Cross-reference DB rows with on-disk assignments for ghost/missing checks.
5. **Implement `workspace.*` and `integrations.*`.** Read `.syntaur/context.json` from cwd if present; otherwise skip the whole category. Integrations checks are `fs.stat` on configured paths.
6. **Wire `src/commands/doctor.ts`.** Export `doctorCommand: Command` mirroring `src/commands/backup.ts:22`. Register in `src/index.ts` alongside the other `import { ... } from './commands/...'` lines and `program.addCommand(doctorCommand)`.
7. **Build human output (`output-human.ts`).** Group by category. Use plain ANSI codes (`\x1b[...m`) — no `chalk`. Summarize at the bottom: `X passed, Y warnings, Z errors`.
8. **Build JSON output (`output-json.ts`).** Keep structure identical to `CheckResult`. Add a snapshot test (clean-repo golden file) to lock the schema.
9. **Implement `--fix`.** v1 auto-fix set is **empty** (we dropped session/server pruning and don't have a mission-rebuild helper yet). Accept the flag but report "no auto-fixes available in v1" if passed. Wiring stays so v2 can add fixes without CLI churn.
10. **Slash command file.** Create `platforms/claude-code/commands/doctor-syntaur/doctor-syntaur.md` with YAML frontmatter matching the track-session/track-server shape (`name`, `description`, `arguments`). See slash command section below for exact body.
11. **Align protocol surfaces.** Add a reference to `syntaur doctor` in the troubleshooting/recovery section of:
    - `platforms/claude-code/skills/syntaur-protocol/SKILL.md`
    - `platforms/codex/skills/syntaur-protocol/SKILL.md`
    - `src/templates/codex-agents.ts`
    - Root `README.md`
    (Same one-liner in each; this is documentation sync, not a semantic change.)
12. **Tests in `src/__tests__/doctor/`.**
    - `env.test.ts`, `structure.test.ts`, `mission.test.ts`, `assignment.test.ts`, `dashboard.test.ts`, `workspace.test.ts`, `integrations.test.ts` — each seeds a temp `$HOME` via the pattern in `src/__tests__/assignment-resolver.test.ts`.
    - `json-schema.test.ts` — snapshot clean-repo JSON output.
    - `cli.test.ts` — exit codes (0 clean, 1 errors, 2 no root) via child process.

---

## `/doctor-syntaur` — slash command design

Location: `platforms/claude-code/commands/doctor-syntaur/doctor-syntaur.md`

### File shape

Follow `platforms/claude-code/commands/track-session/track-session.md`:

```markdown
---
name: doctor-syntaur
description: Diagnose and help recover from common Syntaur bad states
arguments:
  - name: args
    description: "Optional flags: --verbose, --only <check-id>"
    required: false
---

# /doctor-syntaur

<body — see Behavior section>
```

### Behavior

1. **Run the CLI and capture both output and exit code.** Exit code 1 is expected (= issues found), so don't fail the turn on it:

   ```bash
   output=$(syntaur doctor --json 2>&1); exit_code=$?
   ```

   Parse `$output` as JSON. If parsing fails, surface the raw output — the CLI itself broke.
2. **If exit code is 2** — Syntaur isn't initialized. Suggest `syntaur init` and stop.
3. **If exit code is 0** — summarize in one line ("all checks passed") and stop.
4. **If exit code is 1** — summarize results grouped by category. Show errors first, then warnings. Skip passes unless `--verbose` was passed. Always show the `check.id` so the user can reference issues.
5. **Remediation, per issue:**
   - `remediation.kind === 'auto-safe'` — offer to run `syntaur doctor --fix --only <id>`. **Ask before running.** (Note: v1 has no auto-safe remediations yet; placeholder for v2.)
   - `remediation.kind === 'manual'` — if the fix is a file edit inside the agent's write boundaries (e.g., setting `workspace.worktreePath` in an assignment the agent owns), offer to do it after showing the diff. Otherwise show the `suggestion` verbatim.
   - `remediation.kind === 'auto-destructive'` — never auto-run. Describe impact and let the user decide.

### Arguments

- `/doctor-syntaur` — run everything
- `/doctor-syntaur --verbose` — include passes in the summary
- `/doctor-syntaur --only <check-id>` — re-run one check after remediation

### Guardrails to bake into the prompt

- Must invoke `syntaur doctor --json`, never re-derive checks from scratch.
- Must respect the write boundary rules from `syntaur-protocol` — no writing to `mission.md`, other agents' assignment folders, derived `_*.md` files.
- Must show `check.id` next to each issue.
- Must never run `--fix` without explicit user confirmation.

---

## Rollout

1. Ship `syntaur doctor` in the CLI (PR 1). Bump minor version, publish to npm.
2. Ship `/doctor-syntaur` + protocol-surface alignment (PR 2, depends on PR 1 being published).
3. Future: mirror to codex platform; consider a `syntaur-troubleshooting` skill in the skills repo if discovery is a problem; add v2 auto-fixes once there's a mission-rebuild helper and session PID/heartbeat tracking.

---

## Resolved decisions

1. **Dashboard DB unreachable** → `error`. Treated as core, not optional.
2. **`--fix` UX for `mission.manifest-stale`** → not auto-fixable in v1 (no rebuild helper). Warn-only.
3. **Check ordering** → fail-fast. Bail after `env.syntaur-root-exists` fails.
4. **Stale-in-progress detection** → dropped from v1.
5. **`chalk`** → not used; zero-dep ANSI instead.
6. **`dashboard.dead-sessions` / `dead-servers`** → dropped from v1 (no PID/heartbeat in session model).
7. **Config file** → `~/.syntaur/config.md`, not `config.json`.
8. **Dashboard DB scope** → `sessions` table only. Cross-referencing assignments from the DB is deferred until a schema migration adds an assignment index; replaced the planned `missing-assignments` / `ghost-assignments` checks with `ghost-sessions`.

---

## Open questions

1. **Custom `StatusConfig`**: `assignment.required-files-by-status` assumes `in_progress` / `review` / `completed` semantics. If a user has a custom `StatusConfig`, the mapping breaks. Proposal: only run the file-by-status sub-check when the configured statuses are a superset of the defaults, else skip with a note.
2. **`env.cli-version` network dependency**: hit npm registry each run, or cache for a day? Proposal: no cache in v1; 2s timeout; degrade to `skipped` on failure.
