# Syntaur - High-Level Plan

## Vision

An agent-first, human-second task management platform. Agents coordinate work through a markdown-based protocol. Humans manage and observe through a dashboard. The mission folder structure *is* the API — any agent that can read and write files is compatible.

## Core Concepts

- **Mission** — a high-level goal (analogous to a Jira epic). Contains one or more assignments.
- **Assignment** — a single unit of work owned by one agent (analogous to a Jira ticket). Lives in its own folder with structured markdown files.
- **Protocol** — the file structure, formats, and lifecycle rules that agents follow. Agent-framework agnostic.
- **Adapters** — thin config layers that teach specific agent frameworks (Claude Code, Cursor, Codex, OpenCode) how to follow the protocol.

## Architecture

Three layers:

1. **Protocol** — mission/assignment folder structure, markdown file formats, lifecycle state machine. The spec.
2. **Tooling** — CLI for scaffolding, index rebuild script, sync daemon, local dashboard. The npm package.
3. **Adapters** — framework-specific instructions/plugins. Ship the major ones, community builds the rest.

## Key Design Decisions

- **Markdown as database.** LLMs read markdown natively. No serialization, no query language, no SDK needed. Human-inspectable without tooling.
- **Agents only write to their own assignment folder, plus shared resources/memories.** Assignment folders are single-writer (only the assigned agent). Resources and memories folders are shared-writable (any agent or human can create files). Derived files (indexes, mission status) are rebuilt by a script, not maintained by agents.
- **Indexes are derived artifacts.** Rebuilt by scanning folders, not maintained live by agents. Single-writer model for shared files.
- **One-off assignments are single-assignment missions.** Keeps the data model uniform. CLI tooling reduces the ceremony.
- **Mission folder is separate from code repos.** Assignments reference repos via worktree path and branch name. The mission folder is operational state, not source code.
- **No git for the mission folder.** Sync is handled by a sidecar daemon, not version control.
- **Coordinator is mostly a script, not an LLM.** Mechanical rollup (status computation, index rebuilds) doesn't need reasoning. LLM invoked only when judgment is needed (conflict detection, surfacing decisions to humans).

## Directory Structure

```
~/.syntaur/
  missions/
    mission-1/
      manifest.md              # Derived: root index linking to all indexes and config
      mission.md               # Human-authored: overview, goal, context
      _index-assignments.md    # Derived: assignment summary table
      _index-plans.md          # Derived: plan summary table
      _index-decisions.md      # Derived: decision record summary table
      _index-sessions.md       # Derived: active sessions
      _status.md               # Derived: computed mission status, rollup, dependency graph
      claude.md                # Human-authored: Claude Code agent instructions
      agent.md                 # Human-authored: generic agent instructions
      assignments/
        <assignment-slug>/
          assignment.md        # Agent-writable: the assignment record (source of truth)
          plan.md              # Agent-writable: implementation plan
          scratchpad.md        # Agent-writable: working memory
          handoff.md           # Agent-writable: append-only handoff log
          decision-record.md   # Agent-writable: append-only decision log
      resources/
        _index.md              # Derived: resource listing
        <resource-slug>.md     # Shared-writable
      memories/
        _index.md              # Derived: memory listing
        <memory-slug>.md       # Shared-writable
    mission-2/
      ...
```

## Growth Path

- **v1: Local only.** Single machine. CLI + dashboard + Claude Code adapter.
- **v2: Hybrid sync.** Sidecar daemon syncs mission folder to cloud storage. Multiple machines can participate.
- **v3: Event bus.** Real-time notifications between machines when assignments change state.
- **v4: Managed cloud offering.** Hosted backend, dashboard, and sync infrastructure.

---

## Chunks of Work

### Chunk 1: Core Protocol & File Structure
Define and document the spec — mission folder structure, assignment folder structure, all markdown file formats with their fields and frontmatter. Deliverable: a spec doc and example mission folder with sample files.

### Chunk 2: CLI Scaffolding Tool
`syntaur init`, `syntaur create-mission`, `syntaur create-assignment`. Generates the folder structure with boilerplate. Handles the one-off assignment case (auto-wrapping in a mission). npm package skeleton.

### Chunk 3: Index Rebuild & Status Computation
The script that scans assignment folders, rebuilds index files, and computes mission-level status. The "dumb coordinator." Triggered by agents after completing work or callable manually via `syntaur rebuild`.

### Chunk 4: Assignment Lifecycle Engine
The state machine — pending, in_progress, blocked, review, completed, failed. Validation rules for transitions. CLI commands: `syntaur assign`, `syntaur complete`, `syntaur block`.

### Chunk 5: Claude Code Adapter
Plugin with skills (`/grab-assignment`, `/plan-assignment`, `/complete-assignment`), hooks (enforce write boundaries), and CLAUDE.md instructions. Primary agent framework for initial release.

### Chunk 6: Dashboard (Local)
Local web server reading the mission directory. Mission list view, mission detail with assignment statuses, assignment detail with plan/decisions/scratchpad. Real-time updates via file watcher. Read-only in v1.

### Chunk 7: Additional Adapters
Cursor rules, Codex AGENTS.md, OpenCode config. Same protocol, different instruction formats. Community-contributable.

### Chunk 8: Sync Daemon & Cloud
Sidecar that watches for local changes and syncs to cloud storage. Pull mechanism for other machines. Conflict resolution.

---

## Build Order

Chunks 1-4 are the core — the protocol, CLI, and lifecycle engine. Build sequentially.

Chunk 5 (Claude Code adapter) makes it usable with real agents. Build immediately after core.

Chunk 6 (dashboard) makes it manageable for humans. Can be built in parallel with Chunk 5.

Chunks 7-8 are growth. Build after v1 is validated.
