# Syntaur Protocol Specification

**Version:** 1.0

---

## 1. Introduction

The Syntaur protocol is a markdown-based file structure and format that serves as the "API" for the Syntaur platform. It defines how missions (high-level objectives), assignments (units of work), and their associated metadata are organized on the filesystem.

Any agent framework that can read and write files can participate in the Syntaur protocol. There is no proprietary wire format, no database to connect to, and no SDK to install. The protocol is the file system layout itself: a set of markdown files with YAML frontmatter arranged in a specific directory structure under `~/.syntaur/`.

Agents discover work by reading markdown files, report progress by updating markdown files, and coordinate with each other through the structure the protocol defines. Humans oversee and steer missions by editing the files they own. Derived files — rebuilt automatically by tooling — provide at-a-glance dashboards of mission state.

This document is the authoritative conceptual reference for the protocol. For detailed field-level schemas of every file type, see [file-formats.md](./file-formats.md). A reader should be able to understand the entire protocol from this document alone.

---

## 2. Design Principles

### Markdown-as-Database

Every file in the protocol uses YAML frontmatter for structured, machine-readable fields and a markdown body for human-readable prose. This means a single file serves both as a data record and as a readable document. There is no separate database — the filesystem is the database.

### Agent-Framework Agnostic

The protocol does not assume any particular agent framework. Claude Code, Cursor, Codex, custom scripts — anything that can read a file and write a file can participate. Framework-specific configuration (e.g., `claude.md` for Claude Code) supplements the universal protocol files but is never required.

### Human-Readable

Every file in the protocol can be opened in a text editor and understood without specialized tooling. Status, dependencies, progress, and decisions are all visible as plain text. Derived files like dependency graphs use Mermaid syntax that renders in most markdown viewers.

### Machine-Parseable

YAML frontmatter provides structured fields with defined types and valid values. Tooling can parse frontmatter to build indexes, compute status rollups, enforce lifecycle rules, and power dashboards — all without fragile regex parsing of prose content.

### Minimal Nesting

The directory structure is intentionally flat. Missions contain assignments, and that is the deepest nesting goes. Cross-references between assignments use slugs, not deeply nested paths. Index files at the mission level provide navigation without requiring directory traversal.

### Derived Indexes

Computed files (index tables, status rollups, dependency graphs) are rebuilt from canonical sources by tooling. They are never manually edited. This separation means the canonical data (assignment frontmatter) is always authoritative, and the derived views are always reconstructable.

---

## 3. Directory Structure

The root of all Syntaur data is `~/.syntaur/`. Below is the full directory tree with every file's purpose:

```
~/.syntaur/
  config.md                          # Global Syntaur configuration (optional)
  missions/
    <mission-slug>/
      manifest.md                    # Derived: root navigation file linking all indexes and config
      mission.md                     # Human-authored: mission overview, goal, context, success criteria
      _index-assignments.md          # Derived: assignment summary table with status counts
      _index-plans.md                # Derived: plan status summary table
      _index-decisions.md            # Derived: decision record summary table
      _index-sessions.md             # Derived: active sessions across all assignments
      _status.md                     # Derived: computed mission status, assignment rollup, dependency graph
      claude.md                      # Human-authored: Claude Code-specific agent instructions
      agent.md                       # Human-authored: universal agent instructions (all frameworks)
      assignments/
        <assignment-slug>/
          assignment.md              # Agent-writable: the assignment record (source of truth for state)
          plan.md                    # Agent-writable: implementation plan
          scratchpad.md              # Agent-writable: unstructured working memory
          handoff.md                 # Agent-writable: append-only handoff log
          decision-record.md         # Agent-writable: append-only decision log
      resources/
        _index.md                    # Derived: resource listing
        <resource-slug>.md           # Shared-writable: reference material for the mission
      memories/
        _index.md                    # Derived: memory listing
        <memory-slug>.md             # Shared-writable: learnings discovered during the mission
```

### Key structural observations

- **One folder per mission.** The folder name is the mission slug and matches the `slug` field in `mission.md` frontmatter.
- **One subfolder per assignment.** The folder name is the assignment slug and matches the `slug` field in `assignment.md` frontmatter.
- **Derived files use an underscore prefix** (`_index-*`, `_status.md`, `_index.md`). This sorts them to the top of directory listings and signals "do not edit manually."
- **`manifest.md` is the entry point.** An agent starting work on a mission reads `manifest.md` first to discover all other files.
- **Resources and memories live at the mission level**, not inside assignments. They are shared context available to all assignments in the mission.

---

## 4. File Ownership Rules

Every file in the protocol belongs to exactly one of four ownership categories. These categories determine who may write to a file and how conflicts are avoided.

### Human-Authored

Files written and maintained exclusively by humans. Agents read these but never modify them.

| File | Purpose |
|------|---------|
| `mission.md` | Mission overview, goal, context, success criteria |
| `agent.md` | Universal agent instructions for the mission |
| `claude.md` | Claude Code-specific instructions |

### Agent-Writable

Files inside assignment folders. Only the assigned agent writes to its own assignment folder. This single-writer guarantee prevents conflicts between concurrent agents.

| File | Purpose |
|------|---------|
| `assignment.md` | Assignment record and source of truth for state |
| `plan.md` | Implementation plan |
| `scratchpad.md` | Unstructured working notes |
| `handoff.md` | Append-only handoff log |
| `decision-record.md` | Append-only decision log |

**Exception:** The Questions & Answers section of `assignment.md` accepts answers from humans or other agents. These writes are mediated through CLI tooling (e.g., `syntaur answer`), not by directly editing the file, to preserve the single-writer guarantee.

### Shared-Writable

Files in the `resources/` and `memories/` folders. Both humans and agents can create and update files here. There is no single-owner constraint — these are shared mission context.

| File | Purpose |
|------|---------|
| `resources/<resource-slug>.md` | Reference material (docs, API specs, architecture notes) |
| `memories/<memory-slug>.md` | Learnings and patterns discovered during the mission |

The `source` field in each file's frontmatter tracks who created it (e.g., `"human"`, `"claude-1"`), providing authorship provenance.

### Derived

Files generated by the rebuild script. Never edited manually. Always reconstructable from canonical sources.

| File | Purpose |
|------|---------|
| `manifest.md` | Root navigation file |
| `_index-assignments.md` | Assignment summary table |
| `_index-plans.md` | Plan status summary |
| `_index-decisions.md` | Decision record summary |
| `_index-sessions.md` | Active sessions listing |
| `_status.md` | Computed mission status, rollup, and dependency graph |
| `resources/_index.md` | Resource listing |
| `memories/_index.md` | Memory listing |

---

## 5. Source of Truth

**Assignment frontmatter is the single source of truth for all assignment state.**

This is the most important rule in the protocol. The `status`, `priority`, `assignee`, `dependsOn`, `workspace`, and all other structured fields in an assignment's YAML frontmatter are canonical. Every other representation of this data is a projection:

- The checkbox list in `_status.md` is a projection.
- The summary table in `_index-assignments.md` is a projection.
- The Mermaid dependency graph in `_status.md` is a projection.
- The `by_status` counts in `_index-assignments.md` frontmatter are projections.
- The mission-level `status` in `_status.md` is a projection (computed from assignment states).

**When there is divergence between assignment frontmatter and any derived file, assignment frontmatter wins.** The correct response to a divergence is to re-run the rebuild script, which will regenerate all derived files from the canonical assignment data.

Similarly, `mission.md` frontmatter is the canonical source for mission-level human-authored fields (`archived`, `archivedAt`, `archivedReason`, `title`, `externalIds`). Mission status, however, is not stored in `mission.md` — it is computed from assignment states and written to `_status.md` by the rebuild script.

---

## 6. Lifecycle Overview

### Assignment Statuses

Every assignment has a `status` field in its frontmatter. The valid values are:

| Status | Meaning |
|--------|---------|
| `pending` | Not yet started. May be waiting on dependencies. |
| `in_progress` | Actively being worked on by an assigned agent. |
| `blocked` | Manually blocked due to a runtime obstacle. Requires `blockedReason`. |
| `review` | Work is complete and awaiting review. |
| `completed` | Done. All acceptance criteria met. |
| `failed` | Could not be completed. |

### Dependency Semantics

Assignments declare dependencies via the `dependsOn` field, which lists assignment slugs. Dependency enforcement follows two distinct rules:

- **`pending` with unmet `dependsOn`** = the assignment is waiting for its dependencies to reach `completed` status. The lifecycle engine enforces this: it will not allow a transition from `pending` to `in_progress` while any dependency is not `completed`. No additional field is needed — the combination of `status: pending` and unmet `dependsOn` entries implies "waiting."

- **`blocked`** = a manual or runtime block unrelated to declared dependencies. An agent encounters an obstacle it cannot resolve (e.g., missing credentials, unclear requirements, external system down). The `blockedReason` field is **required** when status is `blocked` and must describe the obstacle.

This distinction matters: `pending` with unmet dependencies is a normal, expected state that resolves automatically when dependencies complete. `blocked` is an exceptional state that requires human intervention.

### Mission Status Rollup

Mission status is not stored in `mission.md`. It is computed by the rebuild script from the collective state of all assignments and written to `_status.md`. The algorithm evaluates rules top-to-bottom; the first matching rule wins:

| Priority | Condition | Resulting Status |
|----------|-----------|-----------------|
| 1 | `mission.md` has `archived: true` | `archived` |
| 2 | ALL assignments are `completed` | `completed` |
| 3 | ANY assignment is `in_progress` or `review` | `active` |
| 4 | ANY assignment is `failed` | `failed` |
| 5 | ANY assignment is `blocked` | `blocked` |
| 6 | ALL assignments are `pending` | `pending` |
| 7 | Otherwise | `active` |

**Valid mission statuses:** `pending`, `active`, `blocked`, `completed`, `failed`, `archived`.

Note that `archived` is a **human-authored override** stored in `mission.md` frontmatter (the `archived`, `archivedAt`, and `archivedReason` fields). It is the only mission status that is not computed from assignment states. It signals "this mission is done, regardless of assignment completion state."

### Edge Case Examples

These examples illustrate how the first-match-wins algorithm handles non-obvious situations:

- **2 completed + 1 pending + 0 active** = `active` (rule 7). Work remains but nothing is running. This signals to the human that assignments need to be started.

- **1 completed + 1 blocked + 1 pending** = `blocked` (rule 5). The blocked assignment takes precedence over pending ones.

- **1 in_progress + 1 failed + 1 completed** = `active` (rule 3). Active work takes precedence over failures — the mission is still being worked on.

- **3 completed** = `completed` (rule 2). All work is done.

- **Human sets `archived: true` on `mission.md`** = `archived` (rule 1). Overrides everything, regardless of assignment states.

---

## 7. Naming Conventions

### Mission Slugs

Lowercase, hyphen-separated. The slug is used as the mission folder name and stored in the `slug` field of `mission.md` frontmatter.

Examples: `build-auth-system`, `migrate-to-postgres`, `q1-performance-audit`

### Assignment Slugs

Lowercase, hyphen-separated. The slug is used as the assignment folder name and stored in the `slug` field of `assignment.md` frontmatter.

Examples: `design-auth-schema`, `implement-jwt-middleware`, `write-auth-tests`

### Derived Files

All derived files use an underscore prefix to distinguish them from human-authored and agent-writable files:

- `_index-assignments.md`
- `_index-plans.md`
- `_index-decisions.md`
- `_index-sessions.md`
- `_status.md`
- `_index.md` (inside `resources/` and `memories/`)

The underscore prefix serves two purposes: it sorts derived files to the top of directory listings, and it provides a clear visual signal that these files should not be edited manually.

### Resource and Memory Slugs

Lowercase, hyphen-separated. The filename (slug) is the canonical identifier for resources and memories. Unlike missions and assignments, they do not carry a separate `id`/`slug` in frontmatter — the `name` field is display-only.

Examples: `auth-requirements.md`, `postgres-connection-pooling.md`

---

## 8. Timestamp & Path Normalization

### Timestamps

All timestamps throughout the protocol use **RFC 3339 / ISO 8601 with UTC offset**.

Format: `2026-03-18T14:30:00Z`

This applies to every timestamp field in frontmatter (`created`, `updated`, `generated`, `archivedAt`, etc.) and to timestamps in markdown body content (progress entries, handoff dates, decision dates, session times).

### Filesystem Paths

**Local filesystem path fields** (`workspace.worktreePath`, `defaultMissionDir`, and any other local path stored in YAML frontmatter or config) use the **absolute expanded form**. Never store `~` literally — always expand to the full path at write time.

**Note:** `workspace.repository` is exempt from this rule — it may be either a local absolute path or a remote URL (e.g., `https://github.com/org/repo.git`, `git@github.com:org/repo.git`). Only local filesystem paths require absolute expansion.

```yaml
# Correct
workspace:
  worktreePath: /Users/brennen/worktrees/build-auth-system/implement-jwt-middleware

# Incorrect
workspace:
  worktreePath: ~/worktrees/build-auth-system/implement-jwt-middleware
```

**Intra-mission markdown links** (links between files within the same mission folder) use **relative paths** for portability. If a mission folder is moved or renamed, relative links remain valid.

```markdown
## Links
- [Plan](./plan.md)
- [Assignment](./assignments/implement-jwt-middleware/assignment.md)
- [Status](./_status.md)
```

---

## 9. Versioning

The protocol version is tracked in two places:

- **`manifest.md` frontmatter** — the `version` field in each mission's manifest indicates which protocol version the mission was created with.
- **`config.md` frontmatter** — the `version` field in the global config indicates the installed protocol version.

The current protocol version is **`"1.0"`**.

### Forward Compatibility

Protocol version `"1.0"` establishes the baseline. Future versions will follow these principles:

- **Additive changes** (new optional fields, new file types) will increment the minor version and remain backward compatible. A tool that understands version `1.0` can safely ignore fields it does not recognize.
- **Breaking changes** (removed fields, changed semantics, restructured directories) will increment the major version. Tooling should check the version field and warn if it encounters a version it does not support.
- **The `version` field is a string**, not a number, to support semver-style versioning (e.g., `"1.0"`, `"1.1"`, `"2.0"`).

Tooling should always write the version it supports and should handle unknown versions gracefully — logging a warning rather than failing silently or crashing.
