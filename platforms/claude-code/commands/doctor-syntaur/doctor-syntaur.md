---
name: doctor-syntaur
description: Diagnose and help recover from common Syntaur bad states
arguments:
  - name: args
    description: "Optional flags: --verbose, --only <check-id>"
    required: false
---

# /doctor-syntaur

Run `syntaur doctor` and help the user interpret the results, remediating issues where appropriate. Respect Syntaur write boundaries throughout.

## Usage

- `/doctor-syntaur` — run all checks
- `/doctor-syntaur --verbose` — include passing checks in the summary
- `/doctor-syntaur --only <check-id>` — re-run one check after remediation (e.g. `--only assignment.workspace-missing`)

## Instructions

When the user runs this command:

### Step 1: Parse arguments

From the argument string, extract optional flags:

- `--verbose` — pass through to the CLI and include passing checks in the summary
- `--only <check-id>` — pass through to the CLI to restrict to a single check

### Step 2: Run the CLI and capture output + exit code

Exit code 1 is expected (means issues were found). Do NOT let a non-zero exit fail the turn. Use a pattern like:

```bash
output=$(syntaur doctor --json [--only <check-id>] 2>&1); exit_code=$?
```

Then parse `$output` as JSON. If the JSON fails to parse, surface the raw output — that means the CLI itself broke.

### Step 3: Handle exit codes and severity

- **Exit 2** — Syntaur isn't initialized. Tell the user to run `syntaur init` and stop.
- **Exit 1** (one or more errors) — continue to step 4; report both errors and warnings.
- **Exit 0 and `summary.warn === 0`** — everything passed. Say so in one line (e.g. "All checks passed — no issues found.") and stop.
- **Exit 0 and `summary.warn > 0`** — no errors but warnings exist. Continue to step 4; report the warnings. The CLI only exits 1 on errors, so warn-only runs still need to be surfaced to the user.

### Step 4: Summarize results

Group the `checks` array from the JSON by `category`. For each category:

- Show errors first, then warnings.
- Skip passes unless `--verbose` was passed.
- Always include the `check.id` so the user can reference a specific issue in follow-up.

Format each issue like:

```
[category] check.id — title
  detail line
  affected: path (truncate long lists)
  fix: remediation.suggestion
```

### Step 5: Establish your write boundary (before offering any edit)

Doctor reports issues from anywhere under `~/.syntaur/`. You are NOT allowed to edit most of those files. Before offering any remediation edit, compute your current write boundary:

1. Read `.syntaur/context.json` in the current working directory (the same `cwd` you ran the CLI from).
2. If the file does not exist, or exists but has no assignment fields (`missionSlug`, `assignmentSlug`, `missionDir`, `assignmentDir`):
   - You have NO assignment context.
   - Your only permitted edit target is the literal file `<cwd>/.syntaur/context.json` itself.
   - For every other issue, show the `suggestion` text verbatim and do NOT offer to edit.
3. If the file has assignment fields, record these paths:
   - `assignmentDir` — your per-assignment write zone.
   - `workspaceRoot` — your code write zone (may be absent).
   - `<cwd>/.syntaur/context.json` — always editable.

### Step 6: Offer remediation (issue by issue)

For each error or warning, determine what kind of offer is appropriate.

**First, use `remediation.kind`:**

- **`auto-safe`** — offer to run `syntaur doctor --fix --only <id>`. Ask the user to confirm before running. (v1 has no auto-safe remediations yet — this is a placeholder for future versions.)
- **`auto-destructive`** — never auto-run. Describe the impact and wait for the user.
- **`manual`** — apply the path check below before offering an edit.

**For `manual` remediations, compare each path in `affected[]` against your boundary from Step 5:**

1. Let `allowed = [assignmentDir, workspaceRoot, <cwd>/.syntaur/context.json]` (dropping any undefined entries).
2. A path is within boundary if and only if it equals `<cwd>/.syntaur/context.json` OR it is a strict path-prefix descendant of `assignmentDir` or `workspaceRoot`. Use path-segment comparison, not substring matching.
3. If **every** path in `affected[]` is within boundary, you may offer to make the edit. Show a diff first; wait for confirmation; then write.
4. If **any** path in `affected[]` is outside your boundary, do NOT offer to edit. Show the `suggestion` text verbatim and tell the user they or another tool must apply it.

**Hard stop list — never write to these regardless of what doctor reports:**

- `mission.md`, `agent.md`, `claude.md`, `manifest.md`, `_status.md`
- Any file starting with `_index-` or ending in `_index.md`
- Any file in a mission's `resources/` or `memories/` directory
- Any file inside a different assignment's folder (i.e. `missions/<m>/assignments/<other>/...` where `<other> !== assignmentSlug`)

### Step 7: Suggest a follow-up

After proposing fixes, suggest the user re-run `/doctor-syntaur --only <check-id>` (or the whole command) to verify that issues resolved.

## Guardrails

- Always invoke `syntaur doctor --json`. Do not re-derive checks from the filesystem yourself.
- Never pass `--fix` without explicit user confirmation.
- Always show each issue's `check.id` so the user can reference it.
- If the CLI output isn't valid JSON, show the raw output and stop — something is wrong with the install.
