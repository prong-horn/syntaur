# SV-12 independent plan review

Reviewer: Claude Code Opus. Date:2026-09-18. Scope: plan completeness, read-only.

# SV-12 plan: closure review (round 3, Opus, read-only)

Scope: only the round-2 items (N1 and L-a..L-d) in `Codex-info/plans/SV-12-dashboard-six-pages.md` (199 lines). I checked the edited sections: route table rows 36/50, Board grammar lines 63–81, the Hotkeys section, line 146, and Tasks 3 and 6. I also checked them against `dashboard/src/App.tsx:59-62` and the `git grep` for the hotkey checker. I made no source or home edits, ran no tests, and spawned no agents.

## Verdict: READY. high=0, medium=0 (conditional)
The condition is that Brennen records hotkey choice A or B via `syntaur log -t answer --answers 2026-09-18T13:27:37Z` plus a decision entry, before any hotkey-dependent edits in Task 6. The plan still does not assume either choice, and neither choice leaves a contradiction.

## Closure
| Item | Status | Evidence |
|---|---|---|
| N1 saved project filter | Closed | Grammar row (l.72): project values come from the URL only; absent or empty means all projects; the saved project filter is never read or written, including in AQL synthesis, and stays untouched on disk. Line 81 restates this: it is ignored on read and write and in query construction, "no URL project means all" is an accepted behavior change, and a regression test covers a saved single-project filter being ignored and byte-preserved. Scope is `p:<slug>` only when the URL has exactly one nonempty slug, so the recursion cannot happen. The "empty vs absent" and "multi-project scope" fixtures can now be written. |
| L-a Library reserved segment | Closed | l.36 and l.50 keep `/library/playbooks/create`, matching current `App.tsx:60`. A playbook slugged `new` stays addressable. A playbook slugged `create` still collides, as it does today, so behavior is unchanged. Agents keep `/new`, which matches legacy `/agents/new`. |
| L-b New ticket without a project | Closed | Task 3: the dialog always has an active-project selector (scratch included), prefilled only from a single active URL project. Submit requires a selection. With no projects, it offers new-project creation and returns with the draft intact. This covers both the Board button and choice A's `n`. |
| L-c Hotkey checker script | Closed | l.146: both variants delete `scripts/check-hotkey-catalog.ts` and update its two references. `git grep` confirms exactly two: `dashboard/src/hotkeys/bindableActions.ts:43` and `src/utils/hotkeysCatalog.ts:24`. No CI caller exists. |
| L-d Scope timing | Closed | l.81 picks the scope key from the URL syntactically, without waiting for `/api/projects`. The scope does not change after the active/archived lookup. Missing or archived slugs show the disclosure or panel and do not reseed filters. The prefs race test is deterministic. |

## Residual wording (nits only; neither blocks implementation)
- l.63 says "Changing a control updates URL and existing preferences". The project control is the exception, stated by the l.72 row and l.81. Optionally add "(except project, URL-only)".
- l.79 says `dialog` "requires appropriate project identity". That now applies to edit-project only; new-ticket uses the Task 3 selector and new-project needs none. Optionally say that.
- Implementation note, not a plan defect: the byte-preservation regression means global-scope writes to other `filters.*` fields must merge and keep the stored `filters.project` key, not replace the whole `filters` object.

This review does not authorize implementation or approval.
