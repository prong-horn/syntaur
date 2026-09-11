# Syntaur audit and v2 recommendation

Date: 2026-09-10. Scope: the `syntaur` repo at main `aa6c088` (v0.80 uncut), the installed plugin (v0.79.0), and read-only measurements of `~/.syntaur`. Nothing was changed.

## 1. Verdict

Syntaur is three products fused together. The first is a markdown work-tracker protocol for coding agents. The second is a workflow-configuration platform (custom statuses, facts, derive ladders, a stage engine, saved views with a query language, hotkeys). The third is an agent operations console (sessions, usage, chat, Needs me, schedules, leases, servers). Usage data says you live in the first and the newest parts of the third. The second is where most of the complexity went and where real use rounds to zero: one workflow, default statuses, three default saved views, zero custom facts.

If we built it again: one short noun (**ticket**), **templates** as the only configurability surface, a **fixed lifecycle moved by explicit verbs** instead of a derive engine, a **three-file ticket folder**, a CLI of about twenty verbs, and a dashboard of six pages. Roughly 40 to 50 percent of the current code is deletable with no loss to how you actually work. The rebuild should be done in place: the parts worth keeping (chat, inbox, sessions, usage) are the newest and best tested, and deleting is cheaper than porting.

## 2. What the evidence says

### 2.1 Scale

| Measure | Value |
|---|---|
| Commits | 1,268 over 6 months (Mar 18 to Sep 10, 2026) |
| Commits per month | Mar 18, Apr 131, May 303, Jun 453, Jul 186, Aug 21, Sep 156 |
| Server source | 87,240 LOC in 336 files, plus 79,010 LOC of tests in 287 files |
| Dashboard SPA | 50,789 LOC, plus 5,029 LOC of tests |
| Skills and hooks | 31 skills (3,088 LOC), 18 slash commands, 6 hook events, 379 LOC shell |
| CLI | 72 top-level commands, about 163 leaf verbs |
| HTTP API | about 257 endpoints |
| SPA | 75 routes, about 50 pages; 21 routes are `/w/:workspace` mirrors |
| SQLite | 14 tables across 6 independently versioned modules |
| Config keys | 30+ in `config.md` |
| Status engines | 3 coexisting (imperative table, derive ladder, stage engine), 5 `migrate-*` commands, 2 marker files |

### 2.2 What you actually use

| Feature | Evidence | Verdict |
|---|---|---|
| Ticket folder core | 324 assignments, 13 projects; 2,428 acceptance criteria; plan.md in 82%; progress entries in 77%; decisions in 52%; handoff in 60% (almost always exactly one) | Keep, simplify |
| Dependencies | `dependsOn` non-empty in 108 of 324 (33%) | Keep |
| Worktree fields | set on every ticket by the e2e cycle | Keep |
| Plan approval gate | 98 real `plan-approve` events; Needs me relies on it | Keep |
| Sessions tracking | 2,678 sessions (claude 1,296, codex 1,240, pi 127, cursor 4) | Keep |
| Usage and cost | $16.6k tracked across Apr–Sep | Keep |
| Chat (ACP) and Needs me | 2 weeks old, 5 chat sessions, 121 items, 20 inbox rows live | Keep, this is the centre of v2 |
| Playbooks | 8 files, 2 disabled, drive your e2e cycle | Keep |
| Statusline | wired in Claude settings | Keep |
| Kanban/table board | view-prefs set per project | Keep |
| Archive | 238 of 324 archived | Keep as a filter, not a page |
| `## Todos` section | 216 tickets, 804 items, but the top lines are "Create plan" 145, "Implement plan" 94, "Review plan" 81, "Review implementation" 79 and variants. Effectively 100% is the four-todo plan ritual. Zero real task tracking | Delete |
| Todo store, bundles, linked todos, promote, request | 5 files, 12 items, last write 2026-06-03; 0 bundles; 1 project todo file | Delete |
| Comments as human/agent channel | 55 of 324 have any; 136 feedback, 114 note, 3 questions ever. Nearly all are review-loop dispositions | Fold into the journal |
| Scratchpad | 15 of 324 have more than the scaffold | Delete |
| Session summaries (`sessions/`) | 19 of 324; the PreCompact prompt hook fails outside the REPL anyway | Delete |
| Proof and capture | 6 of 324, 32 artifacts | Delete; chat attachments cover it |
| Plan versioning | 7 of 324 have plan-v2 | Keep the mechanism, drop the ceremony |
| Custom workflows and statuses | 1 real workflow (`default`) plus a leftover `test.md`; 0 attestations, solicitations, holds; frozenChecks and gateOverrides are engine artifacts | Delete the engine and editor |
| Saved views and query language | 3 views, all defaults (Recently updated, High priority, Stale) | Delete |
| Overview widgets with drag and drop | unmeasurable; the pinned sidebar goes straight to Needs me | Delete |
| Memories and resources | 4 memories, 10 resources across all projects | Delete |
| Schedules | 0 ever created (13 verbs, 2.2k LOC) | Delete |
| Leases and inventories | 0 rows (15 verbs, 1k LOC db) | Delete |
| Servers (tmux tracking) | the March origin; 27 auto-captured `proc-*` files nobody reads | Delete |
| Workspaces | exactly one (`syntaur`); `workspaceGroup` never set; 21 mirrored routes | Delete |
| Standalone UUID tickets | 3 | Replace with a default project |
| Backup to GitHub | `backup.repo: null` | Replace with `git init ~/.syntaur` |
| TUI | 4 launches in shell history | Delete |
| Three install paths for skills | Claude marketplace plugin, `install-plugin`, `npx skills add`; plus codex, cursor, opencode adapters | Keep one |
| Hotkeys and command palette | unmeasurable (3.9k LOC) | Undecided, see section 6 |
| Search | unmeasurable | Keep, it is small |

What the human types: `syntaur dashboard` 13 times, `tui` 4, `update`/`upgrade` 8, `try`/`untry` 4, one `complete`. Every lifecycle verb is run by agents. The CLI is an agent API; the dashboard is the human surface.

What the lifecycle really does (status-change events on real projects): `derive` 243, `complete` 182, `plan-approve` 98, `work-start` 51, `migrate-derive` 47, `create` 33, `recompute` 27, `stage-open` 16, `implement` 8, `dep-terminal` 5, `block` 1, `unpark` 1. Strip the engine noise and the whole lifecycle is create, approve plan, start, complete.

Ticket types: feature 248, bug 46, refactor 15, chore 7, research 4, spike 2, design 2. Priorities: medium 192, high 127, low 4, critical 1.

Who the tickets are for: 183 of 324 (56%) are `syntaur-meta`. The tool building itself is its own biggest workload, which is how a tool grows features that serve its own development rather than the other projects.

### 2.3 How it morphed

- March: a tmux server tracker (`servers/`, ServersPage).
- April: assignments, todos, statusline, palette, dashboard.
- May: leases, saved views, proof artifacts, capture, bundles, themes, usage, archive, kanban, dependency graph, transcribers, terminal picker, platform adapters.
- June (453 commits): the big dashboard month plus inbox, sessions, engagement, staleness, facts, workflow, schedules, search, widgets with drag and drop.
- July: TUI (25 feature commits), daemon (18), workflows and stage engine (17), migrations.
- August: quiet.
- September: assignment chat over ACP, Needs me, live cards, snooze. This is the best-designed slice of the codebase.

### 2.4 Hygiene findings

1. **Tests write into your real home.** Of 34,823 rows in the events table, 33,668 belong to test fixtures (`assignment-1` 2,587 rows, `test-id` 2,425, actors `someone-else`, `codex-shaper`, `and-someone-else`). `tier3-violations.log` (862 lines) and `daemon.log` contain only temp-path test output. Root cause is home resolution at module scope or through `os.homedir()` in some paths rather than an injected root. This is probably also behind the untouched-file flakes we saw when the suite overlapped a reviewer's vitest run.
2. **The write-boundary hook is unwired.** `enforce-boundaries.sh` exists in the plugin but is referenced by neither `hooks.json` nor `~/.claude/settings.json`, while the skills say boundaries are enforced.
3. **The derive engine logs each transition three times** (`sweep`, `dep-terminal`, `derive` at the same timestamp).
4. **Three status engines coexist**, gated by two marker files, with five migration commands still shipped.
5. **Docs drift:** 19 frontmatter fields parsed but undocumented; the spec has no `draft` status but the template seeds it; the config template emits `version: "1.0"` against a `2.0` protocol; the doctor allowlist misses `assignments/`, `agents/`, `schedules/`, `workflows/`, `targets/`, `saved-views.json`; the spec says the DB holds servers.
6. **Plugin drift:** 6 skills on disk are not registered in `plugin.json`; the `doctor-syntaur` command has no skill; 17 of 31 skills are single-verb wrappers.
7. **Three todo implementations** (global, workspace, project) total about 7k LOC.
8. **No SPA data layer:** 223 raw `fetch()` sites; `useProjects.ts` is 975 LOC holding 29 hooks. Largest files: `broker.ts` 4,017, `api-write.ts` 3,688, `api.ts` 3,442, `AssignmentsPage.tsx` 2,174, `config.ts` 2,127.
9. **`readConfig` hardcodes `types: null`**; type definitions only reach callers through a separate getter.
10. **`plan.md` `status:` is never maintained** (147 `in_progress`, 100 `draft`, on mostly completed tickets). Approval already lives in `assignment.md`.
11. Cruft: five `syntaur.db*.bak` files (about 100 MB), 60+ untracked screenshots at the repo root, a leftover `workflows/test.md`.

## 3. If we built it again

### 3.1 One noun: ticket

Rename assignment to **ticket**. You already say it: your own playbook step 6 reads "Implement the ticket", the PreCompact hook says "cross-ticket handoff", and the newest engine code uses it in comments 130 times. "Task" is the other candidate but it collides with Claude Code's Task tool and TaskCreate, and inside plan files "task" already means a plan step. Ticket is short, unambiguous, and reads correctly with stages.

Because there is one noun, the verbs drop it: `syntaur new`, `syntaur ls`, `syntaur show`, `syntaur plan`, `syntaur approve`, `syntaur start`, `syntaur done`. Skills follow the same shape.

### 3.2 Templates replace types, todos, and the workflow engine

A template is a directory under `~/.syntaur/templates/<name>/`:

```
templates/bug/
  template.md   # label, stages, requiresPlan, requiresReview, playbooks, defaultPriority
  ticket.md     # section skeleton (Objective, Repro, Acceptance Criteria, Context)
  plan.md       # optional skeleton
```

Built-ins:

| Template | Stages | Plan | Review | Replaces |
|---|---|---|---|---|
| `feature` | backlog, planning, ready, in_progress, review, done | required, approval-gated | required | today's full cycle |
| `bug` | backlog, in_progress, review, done | optional | required | `type: bug` |
| `spike` | backlog, in_progress, done | none | none | research, spike, design |
| `quick` | backlog, done | none | none | the todo store, `chore`, the `## Todos` section |

`quick` is the todo replacement: one file, two stages, a small card on the board, and `syntaur retemplate <slug> feature` when it grows up. The template also tells Needs me what to ask of you (plan approval only when the template requires a plan) and which playbooks apply. A custom template is a copied directory. That is the entire configurability story: no status editor, no facts, no ladders, no workflow files, no migrations.

### 3.3 Fixed lifecycle, explicit verbs

Status is a stored field chosen from the template's stage list, moved only by verbs: `plan`, `approve`, `start`, `review`, `done`, `drop`, `reopen`. Two booleans, `blocked` and `parked`, are flags, not states. `depends_on` is checked when you run `start` and shown as a badge, never derived into a status. The real event counts show this is all the lifecycle ever does; the derive and stage engines (6.3k LOC of lifecycle code, 7.3k LOC of editor SPA, five migrations) added three-way duplicate logging and nothing you use.

### 3.4 The ticket folder: three files plus plan and chat

```
projects/<slug>/tickets/<slug>/
  ticket.md     # frontmatter, Objective, Acceptance Criteria, Context, Links. The only agent-editable file.
  journal.md    # append-only typed entries: progress | decision | handoff | note | question
  plan.md       # optional; plan-v2.md on replan; approval digest stored in ticket.md
  chat/         # broker-owned events.jsonl, participants.json, attachments/
```

The journal replaces `progress.md`, `decision-record.md`, `handoff.md`, `comments.md`, and `scratchpad.md`. Every one of those is a timestamped entry by an author with a type; only the file names differ. Agents append with `syntaur log -t decision "..."`; the CLI owns the file. `syntaur show --handoff` prints the last handoff entry for the next agent. With one editable file the write-boundary hook becomes almost moot.

Frontmatter shrinks from 35 fields to about 15: `id, slug, title, project, template, status, priority, blocked, parked, depends_on, assignee, tags, links, workspace{repository, branch, worktree}, plan{file, approvedDigest, approvedAt}, created, updated`.

### 3.5 Home layout

```
~/.syntaur/
  config.md            # ~8 keys
  templates/
  playbooks/
  agents/
  projects/<slug>/project.md
  projects/<slug>/tickets/<slug>/
  syntaur.db           # operational only: sessions, engagement, usage, chat index, events
  inbox-snoozes.json
```

Gone: `workspaces.json`, the standalone `assignments/<uuid>/` tree (use a default `scratch` project), `todos/`, `servers/`, `targets/`, `workflows/`, `saved-views.json`, `view-prefs.json`, memories, resources, the backup subsystem (`git init ~/.syntaur` and commit on a cron instead).

### 3.6 CLI: about twenty verbs

`new, ls, show, plan (create|version), approve, start, review, done, drop, reopen, block, unblock, park, unpark, log, retemplate, worktree (create|remove|gc), session (register|touch|resume), inbox, usage, search, dashboard, doctor, template (list|new), agent (list|test), migrate`. From about 163 leaves to about 30.

### 3.7 Dashboard: six pages

1. **Needs me** (pinned, badge, notifications). Already built.
2. **Board**: kanban or table across projects or one project, filter by template and status. `AssignmentsPage` at 2,174 LOC shrinks because saved views, the query language, and workspace scoping go.
3. **Ticket**: tabs for ticket, plan, journal, chat. The chat tab is already the strongest page.
4. **Sessions**, with the usage rollup embedded rather than a separate Usage page.
5. **Library**: playbooks, agents, templates on one page.
6. **Settings**: theme, agents defaults, notifications.

Deleted: Overview widgets, saved views, the workflow editor and its nine section files, three todo pages, Servers, Inventories, Memories, Resources, Schedules, Archive as a page (it becomes a "done older than 30 days" filter), Help (link to the README), and the 21 `/w/` mirror routes. One `useResource(url)` hook with WebSocket invalidation replaces 223 raw fetch calls.

### 3.8 Agent surface

One skill pack installed one way (`npx skills add`). Drop the Claude marketplace plugin path, `install-plugin`, `install-codex-plugin`, the codex, cursor, and opencode adapter templates, and `targets/`. Six skills: `syntaur-protocol`, `grab`, `plan`, `done`, `log`, `worktree`. Agents that work through ACP chat need no skills at all because the broker files their records itself, and that is where Cursor and Codex already sit. Hooks keep SessionStart register and the touch hook; drop the PreCompact and ExitPlanMode prompt hooks, and delete the unwired boundary script.

### 3.9 Rules that would have prevented the sprawl

1. **One injected root.** Every module takes the home directory as a parameter; tests get a temp root; a lint fails the build on `homedir()` or `syntaurRoot()` at module scope. This alone prevents finding 1.
2. **No configurability without a second user.** You are the only user. Hardcode it; keep a template directory for the cases that vary.
3. **Delete anything with zero real use after 60 days.** Log verb invocations (the events table already does) and read it quarterly.
4. **Three files per ticket, fixed.** A new kind of record is a journal entry type, never a new file.
5. **Page budget.** A dashboard page over 500 LOC is split by concept, not into helper files.
6. **Watch the self-build ratio.** When most tickets are about the tool, the tool is drifting.

## 4. Delete list

| Subsystem | Approximate LOC (server + SPA) | Evidence |
|---|---|---|
| Workflow, status, facts, derive ladder, stage engine, editor, 5 migrations | 6,300 + 7,300 + migrations 1,700 | 1 workflow, 0 custom facts, triple-logged transitions |
| Todos (three implementations), bundles, linked todos, promote, request | 3,400 + 3,700 | 12 items, dead since June 3 |
| Saved views, query language, overview widgets | 240 + 5,900 | 3 default views |
| Leases and inventories | 1,100 + 300 | 0 rows |
| Schedules | 2,400 + 400 | 0 created |
| Servers and autodiscovery | 900 + 400 | auto-captured files nobody reads |
| Memories and resources | 800 + 900 | 14 documents total |
| Proof, capture, artifacts | 1,000 | 6 tickets |
| Session summaries and PreCompact hook | 300 | 19 tickets; the hook fails outside the REPL |
| TUI (`browse`) | 300 | 4 launches |
| Platform adapters, three install paths, `targets/` | 3,900 | one user, one install path needed |
| Workspaces, `/w/` routes, workspace visibility | 500 + 700 | one workspace |
| Backup subsystem | 400 | never configured |
| Scratchpad, comments, decision-record, handoff as separate files | folded, not deleted | see 3.4 |

## 5. Keep list (and port list if you start fresh instead)

`src/chat/` (9.3k), `src/inbox/` and the inbox SPA (2.7k), sessions and engagement (6.6k), usage (3.2k), search (1.6k), staleness (used by inbox tiers), playbooks, agents editor, statusline, the parser and scanner and watcher, the WebSocket manager, the markdown editor, kanban and table board components, worktree utilities, the ticket detail page and its chat tab.

## 6. Undecided

Hotkeys and the command palette (3.9k LOC) cannot be measured from disk. If you use cmd-k daily, keep a palette that only does navigation and `new`; if not, delete the whole subtree.

## 7. Migration path, in place

0. **Hygiene, one day.** Inject the root everywhere tests leak; purge the 33,668 test rows from the real events table; delete the DB backups and `workflows/test.md`; wire or delete the boundary hook; register or remove the six orphan skills.
1. **Delete dead subsystems** from section 4. Tests go with them. Ship as the last 0.x release.
2. **Rename** assignment to ticket in one sweep (paths, CLI, API, SPA, skills, docs) with a one-shot `syntaur migrate v2` that renames `assignments/` to `tickets/` and `assignment.md` to `ticket.md` across the 324 existing folders.
3. **Collapse the folder.** The migrator concatenates progress, decisions, handoff, and comments into `journal.md` as typed entries sorted by time, and appends the 15 non-empty scratchpads as `note` entries.
4. **Templates.** Introduce `templates/`, map old types (feature, bug, refactor to `feature`; research, spike, design to `spike`; chore to `quick`), replace the engines with explicit verbs.
5. **Dashboard consolidation** to the six pages, with the single data hook.

Cut v1.0 at the end of step 5. Each step is independently shippable and each is mostly deletion.
