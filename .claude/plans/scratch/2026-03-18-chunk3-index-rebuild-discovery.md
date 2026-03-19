# Chunk 3: Index Rebuild & Status Computation -- Discovery Findings

## Metadata
- **Date:** 2026-03-18
- **Complexity:** large
- **Tech Stack:** TypeScript, Node.js 20+, Commander.js CLI, tsup bundler, ESM modules, vitest

## Objective
Build the `syntaur rebuild` command that scans a mission's assignment folders, parses canonical data from frontmatter and markdown bodies, computes mission-level status, and regenerates all 8 derived index files.

## User's Request
Implement Chunk 3 from the high-level plan: "The script that scans assignment folders, rebuilds index files, and computes mission-level status. The 'dumb coordinator.' Triggered by agents after completing work or callable manually via `syntaur rebuild`."

This is the mechanical "rebuild engine" that reads canonical data (assignment.md, plan.md, decision-record.md frontmatter + body sections) and generates all derived files (_index-assignments.md, _index-plans.md, _index-decisions.md, _index-sessions.md, _status.md, manifest.md, resources/_index.md, memories/_index.md).

## Codebase Overview

### Current State (post-Chunk 2)
The project has a working CLI with three commands: `init`, `create-mission`, `create-assignment`. These create the directory structure and write **empty stub** index files via template functions in `src/templates/index-stubs.ts`. The rebuild command needs to **replace** those stubs with populated versions containing real data scanned from the filesystem.

### Key Architecture Observations
- **No YAML parsing library.** The project has a hand-rolled `parseFrontmatter()` in `src/utils/config.ts` that handles simple key-value and one level of nesting. This is insufficient for parsing assignment frontmatter (which has arrays like `dependsOn`, `externalIds`, and nested objects like `workspace`).
- **Templates use string interpolation.** All existing templates are pure functions that take params and return strings. The rebuild should follow this pattern.
- **Utils are small, focused modules.** Each util file does one thing. The rebuild logic should follow this decomposition.
- **Tests use temp directories.** Integration tests create temp dirs, scaffold missions/assignments, then verify outputs.

### Protocol Spec (docs/protocol/spec.md and file-formats.md)
Comprehensive specs exist defining:
- All 8 derived file formats with exact frontmatter schemas and body structures
- The mission status rollup algorithm (7 rules, first-match-wins)
- Data sources: assignment.md frontmatter is the single source of truth
- Session data comes from markdown tables in assignment body
- Q&A unanswered count comes from `**A:** pending` patterns in assignment body
- Decision record data comes from frontmatter (`decisionCount`) and body parsing (`## Decision N: <title>`, `**Status:**`)

### Sample Mission (examples/sample-mission/)
Complete working example with 3 assignments showing all index files populated. This serves as the test oracle -- the rebuild command should produce output matching these files when given the same input data.

## Files That Will Need Changes

| File | Current Purpose | Needed Change |
|------|----------------|---------------|
| `src/index.ts` | CLI entry point with 3 commands | Add `rebuild` command registration |
| `src/utils/config.ts` | Config reader with private `parseFrontmatter()` | Extract/generalize frontmatter parser or create a new dedicated parser |
| **New:** `src/commands/rebuild.ts` | -- | Main rebuild command handler: accepts `--mission <slug>` or `--all`, orchestrates scanning and writing |
| **New:** `src/rebuild/index.ts` | -- | Barrel export for rebuild modules |
| **New:** `src/rebuild/scanner.ts` | -- | Scans mission directory for assignment folders, resource files, memory files |
| **New:** `src/rebuild/parser.ts` | -- | Robust YAML frontmatter parser + markdown body section parsers (sessions table, Q&A, decision entries) |
| **New:** `src/rebuild/status.ts` | -- | Mission status rollup algorithm (7 rules) |
| **New:** `src/rebuild/render-index-assignments.ts` | -- | Renders populated `_index-assignments.md` |
| **New:** `src/rebuild/render-index-plans.ts` | -- | Renders populated `_index-plans.md` |
| **New:** `src/rebuild/render-index-decisions.ts` | -- | Renders populated `_index-decisions.md` |
| **New:** `src/rebuild/render-index-sessions.ts` | -- | Renders populated `_index-sessions.md` |
| **New:** `src/rebuild/render-status.ts` | -- | Renders populated `_status.md` with rollup, checklist, Mermaid graph, needs-attention |
| **New:** `src/rebuild/render-manifest.ts` | -- | Renders populated `manifest.md` (same structure as template but with fresh timestamp) |
| **New:** `src/rebuild/render-resources-index.ts` | -- | Renders populated `resources/_index.md` |
| **New:** `src/rebuild/render-memories-index.ts` | -- | Renders populated `memories/_index.md` |
| **New:** `src/rebuild/types.ts` | -- | TypeScript interfaces for parsed assignment data, plan data, decision data, resource data, memory data |
| **New:** `src/__tests__/rebuild.test.ts` | -- | Integration tests: scaffold a mission with assignments, run rebuild, verify all 8 output files |
| **New:** `src/__tests__/parser.test.ts` | -- | Unit tests for frontmatter parsing and body section parsing |
| **New:** `src/__tests__/status.test.ts` | -- | Unit tests for the mission status rollup algorithm (all 7 rules + edge cases) |

**Note:** The render files could potentially be consolidated into fewer files. The file-per-index approach matches the granularity of the existing template pattern but may be overkill. A single `src/rebuild/renderers.ts` with multiple export functions would be more pragmatic and is the recommended approach.

## Patterns Discovered

| Pattern | Reference File | Description |
|---------|---------------|-------------|
| Command handler pattern | `src/commands/create-mission.ts` | Async function exported, takes options, uses `readConfig()` for base dir, resolves paths with `resolve()`, uses utils for fs ops. Error thrown as `new Error()`. |
| CLI registration pattern | `src/index.ts` | Commander.js `.command()` with `.description()`, `.argument()` or `.option()`, `.action()` wrapping in try/catch with `process.exit(1)`. |
| Template/render pattern | `src/templates/index-stubs.ts` | Pure functions taking typed params, returning string with template literals. YAML frontmatter + markdown body. |
| Utility module pattern | `src/utils/*.ts` | Small focused modules, one concern each, re-exported through barrel `index.ts`. |
| Test pattern | `src/__tests__/commands.test.ts` | vitest, `mkdtemp` for temp dirs, `beforeEach`/`afterEach` cleanup, test through public API (command functions), verify with `readFile` and string assertions. |
| Frontmatter format | `examples/sample-mission/assignments/*/assignment.md` | `---\n` delimited YAML with string, number, boolean, null, array (both `[]` and `- item` forms), and nested object fields. Values may be quoted or unquoted. |

## CLAUDE.md Rules Found
- No CLAUDE.md exists in the syntaur repo root.
- The global `~/.claude/CLAUDE.md` rules specify: avoid preamble, use `~/.bash_profile` for aliases, plans go in `.claude/plans/`, env vars through GCP Secret Manager (not relevant here).
- The sample mission's `claude.md` (at `examples/sample-mission/claude.md`) demonstrates the format but is not a project rule.

## Data Parsing Requirements

### From assignment.md frontmatter (structured YAML)
- `slug`, `title`, `status`, `priority`, `assignee`, `updated` -- direct fields
- `dependsOn` -- array of strings (may be `[]` or multi-line `- item`)
- `blockedReason` -- string or null
- `workspace` -- nested object with `repository`, `worktreePath`, `branch`, `parentBranch`

### From assignment.md body (markdown parsing)
- **Sessions table:** Parse markdown table rows after `## Sessions` heading. Columns: Session ID, Agent, Started, Ended, Status. Need to extract rows where Status is `active`.
- **Q&A section:** Count entries where the answer is `**A:** pending` (unanswered questions).

### From plan.md frontmatter
- `assignment`, `status`, `updated`

### From decision-record.md frontmatter
- `assignment`, `updated`, `decisionCount`

### From decision-record.md body
- Parse `## Decision N: <title>` headings to get latest decision title
- Parse `**Status:** <status>` to get latest decision status

### From resource files (resources/*.md, excluding _index.md)
- Frontmatter: `name`, `category`, `source`, `relatedAssignments`, `updated`

### From memory files (memories/*.md, excluding _index.md)
- Frontmatter: `name`, `source`, `scope`, `sourceAssignment`, `updated`

### From mission.md frontmatter
- `title`, `archived`, `archivedAt`, `archivedReason`

## Mission Status Rollup Algorithm

Priority order (first match wins):
1. `mission.md` has `archived: true` -> `archived`
2. ALL assignments `completed` -> `completed`
3. ANY assignment `in_progress` or `review` -> `active`
4. ANY assignment `failed` -> `failed`
5. ANY assignment `blocked` -> `blocked`
6. ALL assignments `pending` -> `pending`
7. Otherwise -> `active`

## Key Design Decisions Needed

1. **Frontmatter parser approach:** The existing `parseFrontmatter()` in config.ts is too limited. Options:
   - (a) Add a YAML parsing dependency (e.g., `yaml` npm package) -- cleanest but adds a dep
   - (b) Write a more robust hand-rolled parser supporting arrays and nested objects
   - (c) Enhance the existing parser incrementally
   - **Recommendation:** Option (b) or (a). The protocol uses a well-defined subset of YAML. A focused parser for this subset is reasonable. However, a dependency would be more robust.

2. **Render module organization:** One file per index vs. consolidated renderers file.
   - **Recommendation:** Consolidated `src/rebuild/renderers.ts` with one exported function per derived file. Keeps the module count manageable.

3. **CLI interface for rebuild:** Should support:
   - `syntaur rebuild --mission <slug>` -- rebuild one mission
   - `syntaur rebuild --all` -- rebuild all missions
   - `syntaur rebuild` (no args) -- error or rebuild all?
   - `--dir <path>` -- override mission directory (consistent with other commands)

4. **Markdown body parsing robustness:** The sessions table and Q&A parsing involve regex against markdown. Need to handle:
   - Empty tables (header row only)
   - Missing sections entirely
   - Malformed entries (graceful degradation)

## Questions Asked & Answers

No clarifying questions were needed. The protocol spec, file-formats doc, sample mission, and existing code provide sufficient detail to plan the implementation. The spec is authoritative and comprehensive.

## Exploration Log

| Explorer | Focus Area | Key Findings |
|----------|-----------|--------------|
| Direct reads | Tech stack & project structure | TypeScript/Node.js 20+/Commander.js/tsup/ESM/vitest. 28 source files. No YAML parser dependency. |
| Direct reads | Protocol specs | Complete file format specs for all 8 derived files with frontmatter schemas, body sections, and examples. Status rollup algorithm with 7 rules. |
| Direct reads | Sample mission | Full working example with 3 assignments, 1 resource, 1 memory. All 8 derived files populated. This is the test oracle. |
| Direct reads | Existing code | CLI scaffolding complete. Template stubs produce empty indexes. `parseFrontmatter()` handles simple cases only. Utils are small focused modules. Tests use temp dirs. |
| Direct reads | Assignment data variety | Three assignments showing different states: completed (with sessions, Q&A answered), in_progress (with active session, unanswered Q&A), pending (no sessions, no Q&A, no decisions). Good test coverage variety. |
