# Chunk 4: Assignment Lifecycle Engine -- Discovery Findings

## Metadata
- **Date:** 2026-03-18
- **Complexity:** large
- **Tech Stack:** TypeScript, Node.js 20+, Commander.js, tsup, ESM, vitest

## Objective
Build the assignment lifecycle state machine and CLI commands that validate and execute status transitions on assignment.md files, enforcing dependency rules and required fields per the protocol spec.

## User's Request
From the high-level plan: "The state machine -- pending, in_progress, blocked, review, completed, failed. Validation rules for transitions. CLI commands: `syntaur assign`, `syntaur complete`, `syntaur block`."

This means building:
1. A state machine module defining valid transitions between the 6 assignment statuses
2. Validation logic (dependency checking, required fields like `blockedReason`)
3. CLI commands that read assignment.md, validate the transition, update frontmatter fields (status, assignee, blockedReason, updated timestamp), and write back
4. Integration with the rebuild pipeline (trigger rebuild after transitions)

## Codebase Overview

### Current State (Post-Chunk 2, Chunk 3 NOT yet implemented)
The project has a working CLI (`src/index.ts`) with 3 commands: `init`, `create-mission`, `create-assignment`. The `src/rebuild/` directory does not exist -- chunk 3's plan was written but not implemented.

Key architectural facts:
- **Single runtime dependency:** `commander` only. No YAML parsing library.
- **Templates are pure functions** returning strings. Each takes a typed params object.
- **Utils are small focused modules** (slug.ts=13 lines, timestamp.ts=3 lines, yaml.ts=9 lines).
- **Config parser** (`src/utils/config.ts` lines 24-49) handles only flat key-value and one-level dot-notation. Cannot parse arrays, nested objects with sub-properties, or the full assignment.md frontmatter.
- **Tests use temp directories** with `mkdtemp`, scaffold real files, verify with `readFile` and string assertions.
- **All assignments start as `status: pending`** with `assignee: null` (see `src/templates/assignment.ts` line 23-27).

### Critical Dependency: Frontmatter Parsing
Chunk 3's plan called for a robust frontmatter parser in `src/rebuild/parser.ts` that handles strings, numbers, booleans, null, arrays, and one-level nested objects. Since chunk 3 is not implemented, chunk 4 must either:
- **(A) Build a focused frontmatter read/update utility** that can parse the assignment.md frontmatter subset and serialize it back after modification. This is the recommended approach -- it keeps chunk 4 self-contained.
- **(B) Wait for chunk 3.** Not recommended since the user is asking for chunk 4 now.
- **(C) Build the full chunk 3 parser and reuse it.** Overkill for chunk 4's needs.

**Recommendation:** Option A. Build a `src/utils/frontmatter.ts` (or `src/lifecycle/frontmatter.ts`) that can:
1. Parse assignment.md frontmatter into a typed object
2. Update specific fields (status, assignee, blockedReason, updated)
3. Serialize back to YAML frontmatter + preserve the markdown body unchanged

This is simpler than chunk 3's full parser because we only need to handle the assignment.md schema, and we need round-trip fidelity (parse then serialize back). When chunk 3 is built later, it can either reuse this or build its own read-only parser.

## Files That Will Need Changes

| File | Current Purpose | Needed Change |
|------|----------------|---------------|
| `src/index.ts` | CLI entry with 3 commands (73 lines) | Register new lifecycle commands: `assign`, `start`, `complete`, `block`, `unblock`, `review`, `fail` |
| **New:** `src/lifecycle/state-machine.ts` | -- | Valid transitions map, `canTransition()`, `validateTransition()` with dependency checking |
| **New:** `src/lifecycle/types.ts` | -- | TypeScript types: `AssignmentStatus`, `TransitionResult`, `AssignmentFrontmatter` |
| **New:** `src/lifecycle/frontmatter.ts` | -- | Parse assignment.md frontmatter, update fields, serialize back preserving body |
| **New:** `src/lifecycle/transitions.ts` | -- | Execute transitions: read file, validate, update fields, write file |
| **New:** `src/lifecycle/index.ts` | -- | Barrel export |
| **New:** `src/commands/assign.ts` | -- | `syntaur assign <assignment> --agent <name> --mission <slug>` |
| **New:** `src/commands/start.ts` | -- | `syntaur start <assignment> --mission <slug>` (pending -> in_progress) |
| **New:** `src/commands/complete.ts` | -- | `syntaur complete <assignment> --mission <slug>` |
| **New:** `src/commands/block.ts` | -- | `syntaur block <assignment> --reason <text> --mission <slug>` |
| **New:** `src/commands/unblock.ts` | -- | `syntaur unblock <assignment> --mission <slug>` |
| **New:** `src/commands/review.ts` | -- | `syntaur review <assignment> --mission <slug>` (in_progress -> review) |
| **New:** `src/commands/fail.ts` | -- | `syntaur fail <assignment> --mission <slug>` |
| **New:** `src/__tests__/state-machine.test.ts` | -- | Unit tests for transition validation, dependency checking |
| **New:** `src/__tests__/frontmatter.test.ts` | -- | Unit tests for frontmatter parse/update/serialize round-trip |
| **New:** `src/__tests__/lifecycle-commands.test.ts` | -- | Integration tests: scaffold assignment, run transitions, verify file changes |

## State Machine Design

### Valid Statuses
`pending`, `in_progress`, `blocked`, `review`, `completed`, `failed`

### Valid Transitions (Derived from Protocol Spec)
The protocol spec does not enumerate explicit transitions, but the semantics imply:

| From | To | Conditions | CLI Command |
|------|----|------------|-------------|
| `pending` | `in_progress` | All `dependsOn` assignments must be `completed`; `assignee` must be set | `syntaur start` |
| `in_progress` | `blocked` | `blockedReason` required | `syntaur block` |
| `in_progress` | `review` | None | `syntaur review` |
| `in_progress` | `completed` | None | `syntaur complete` |
| `in_progress` | `failed` | None | `syntaur fail` |
| `blocked` | `in_progress` | Clears `blockedReason` | `syntaur unblock` |
| `review` | `in_progress` | Reviewer sends back for rework | `syntaur start` (or a dedicated `rework` command) |
| `review` | `completed` | Reviewer approves | `syntaur complete` |
| `review` | `failed` | Reviewer rejects permanently | `syntaur fail` |
| `pending` | `blocked` | Manual block before work starts; `blockedReason` required | `syntaur block` |
| `blocked` | `pending` | Unblock back to pending (if was pending before) | `syntaur unblock` |

**`syntaur assign`** is special -- it sets the `assignee` field but does NOT change status. It can be run on any non-terminal assignment (`pending`, `in_progress`, `blocked`, `review`). This separates "who owns it" from "what state it's in."

### Side Effects Per Transition
Every transition updates:
- `status` field
- `updated` timestamp

Specific transitions also update:
- `assign`: sets `assignee` field
- `block`: sets `blockedReason` field
- `unblock`: clears `blockedReason` to `null`
- `start` (pending -> in_progress): requires `assignee` to be set (or accept `--agent` flag)

### Dependency Validation
When transitioning `pending` -> `in_progress`, the engine must:
1. Read the assignment's `dependsOn` array
2. For each dependency slug, read that assignment's frontmatter
3. Verify all dependencies have `status: completed`
4. Reject the transition with a clear error if any dependency is not completed

## Patterns Discovered

| Pattern | Reference File | Description |
|---------|---------------|-------------|
| Command handler structure | `src/commands/create-assignment.ts` | Async function, validates inputs, reads config for base dir, resolves paths, try/catch in CLI registration |
| CLI registration | `src/index.ts` | Each command registered with `.command()`, `.description()`, `.argument()`, `.option()`, `.action()` wrapper with try/catch |
| Pure render/template functions | `src/templates/assignment.ts` | Takes typed params, returns string. No side effects. |
| Utils as small focused modules | `src/utils/slug.ts` (13 lines) | One concern per file, exported via barrel `index.ts` |
| Test structure | `src/__tests__/commands.test.ts` | `mkdtemp` for temp dirs, scaffold real files, read back and assert with `toContain` |
| Module organization | `src/commands/`, `src/templates/`, `src/utils/` | Feature-grouped directories with barrel exports |

## CLAUDE.md Rules Found
- No repo-level CLAUDE.md exists in `/Users/brennen/syntaur/`.
- Global `~/.claude/CLAUDE.md`:
  - Avoid preamble, get to the point
  - Plans in `.claude/plans/` directory, tracked by git
  - Shell aliases go in `~/.bash_profile`
  - Env vars via GCP Secret Manager (not relevant here)
- Sample mission `CLAUDE.md` at `examples/sample-mission/` (the `claude.md` file):
  - Rule: "Do NOT set status to `blocked` for unanswered questions; `blocked` is reserved for hard runtime/manual blockers" -- this informs the state machine design (blocked is exceptional, not for Q&A)

## Questions Asked & Answers

| Question | Answer |
|----------|--------|
| Should chunk 4 wait for chunk 3 (rebuild)? | No -- the user is requesting chunk 4 discovery now. Build a self-contained frontmatter parser for lifecycle needs. |
| Are the 7 CLI commands (assign, start, complete, block, unblock, review, fail) the right set? | The high-level plan mentions `assign`, `complete`, `block`. The additional commands (`start`, `unblock`, `review`, `fail`) are implied by the state machine having 6 states with multiple transitions. Need to confirm with user whether they want all 7 or a subset. |
| Should `syntaur assign` also transition to `in_progress`? | Keeping assign and start separate is cleaner -- assign sets who, start changes state. But the user might want `assign` to optionally also start. |
| Should lifecycle commands auto-trigger rebuild? | Logical since status changed, but rebuild doesn't exist yet (chunk 3). The commands should call rebuild if available, or skip gracefully. |

## Open Questions for User

1. **Command scope:** The high-level plan mentions `assign`, `complete`, `block`. Should we also implement `start`, `unblock`, `review`, and `fail` as separate commands? Or should some be combined (e.g., `assign` also starts, `unblock` auto-resumes)?

2. **Rebuild integration:** Since chunk 3 (rebuild) is not implemented yet, should lifecycle commands simply update the assignment.md file and print a message suggesting `syntaur rebuild`, or should we stub a rebuild call that will be wired up later?

3. **Assign semantics:** Should `syntaur assign` only set the `assignee` field, or should it also transition `pending` -> `in_progress`? The protocol suggests these are separate concerns.

## Exploration Log

| Explorer | Focus Area | Key Findings |
|----------|-----------|--------------|
| Direct read: CLI & commands | `src/index.ts`, `src/commands/*.ts` | 3 commands exist (init, create-mission, create-assignment). Command pattern: async handler, config reading, path resolution, try/catch. Assignments always created as `status: pending`, `assignee: null`. |
| Direct read: Utils & templates | `src/utils/*.ts`, `src/templates/*.ts` | Small focused modules. Only YAML util is `escapeYamlString`. `parseFrontmatter` in config.ts is limited (flat key-value only). Assignment template shows full frontmatter structure including arrays and nested workspace object. |
| Direct read: Protocol spec | `docs/protocol/spec.md`, `docs/protocol/file-formats.md` | 6 valid statuses defined. Dependency semantics: pending+unmet deps = structural wait (automated), blocked = runtime obstacle (human intervention). `blockedReason` required when status is `blocked`. No explicit transition table in spec -- must be derived. |
| Direct read: Tests | `src/__tests__/*.test.ts` | 6 test files. Pattern: vitest, describe/it/expect, temp dirs for integration tests, string assertions for template output. |
| Direct read: Sample mission | `examples/sample-mission/assignments/*/assignment.md` | Real examples of assignments in various states (pending, in_progress, completed). Shows full frontmatter with all fields populated. |
