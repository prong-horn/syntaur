---
name: capture-artifacts
description: >-
  Capture typed proof artifacts (screenshot, video, asciinema, http transcript,
  text note) for the active Syntaur assignment so a human reviewer can verify
  the work in seconds without re-running it. Use after a meaningful change is
  verified, especially when an acceptance criterion is now demonstrably met.
license: MIT
metadata:
  author: prong-horn
  version: "0.1.0"
---

# Capture Artifacts

Attach proof to your work. Reviewers should be able to scroll a single page (`proof.html`) and judge "yep that's what I wanted" or "nope that's not right" — without re-executing anything.

## Input

No arguments. The active assignment is resolved from the session's open engagement (`.syntaur/context.json` is only a workspace marker, not the assignment source).

## Step 1: Decide whether to capture

Capture an artifact when **any** of these is true:
- An acceptance criterion is now demonstrably met (most common trigger).
- A user-facing behavior changed in a way a screenshot, video, transcript, or short text note can show.
- A bug fix produces a before/after worth showing (capture the after; the diff is the before).

Skip when:
- The change is purely internal (refactor, type tightening) with no observable effect.
- The change is already covered by a passing automated test that the reviewer can run trivially.

Linkage to a specific criterion is **optional**. Untagged artifacts are fine — they land in a "Other artifacts" section on the proof page.

## Step 2: Pick the kind by work type

| Work type | Preferred kind | Notes |
|-----------|---------------|-------|
| Web UI change | `screenshot` (single state) or `video` (interaction) | Use the smallest medium that conveys the proof. Screenshots beat videos when one frame suffices. |
| CLI command output | `asciinema` (preferred) or `text` | Asciinema records the actual session; text is fine when output is short and static. |
| Backend API change | `http` (request/response transcript) | Capture the curl invocation + response body. |
| Migration / schema / config | `text` with a `--note` describing the before/after | Or `http` for an API verification call. |
| Anything ambiguous | `text` with `--note` | Always available. Written notes are better than skipped captures. |

## Step 3: Run `syntaur capture`

```bash
# File-based (screenshot, video, asciinema, http transcript)
syntaur capture --kind <type> --file <path> [--criterion <index>] [--note <text>] [--transcribe] \
  [--project <slug> <assignment-slug>]

# Text-only (no --file)
syntaur capture --kind text --note "<what you verified>" [--criterion <index>] \
  [--project <slug> <assignment-slug>]
```

Rules:
- `--kind=text` requires `--note` and forbids `--file`.
- `--kind=http` accepts either `--file` (a transcript) or `--note` (an inline summary). At least one is required.
- All other kinds (`screenshot`, `video`, `asciinema`) require `--file`. The CLI rejects nonexistent / non-file paths.
- `--criterion <index>` is optional — pass the **0-based** index into the `## Acceptance Criteria` checklist when you want to anchor the artifact to a specific criterion.
- `--transcribe` is video-only and writes a sibling `<id>.transcript.md` (requires `ELEVENLABS_API_KEY` + `ffmpeg`). `proof build` renders the transcript next to the player; clicking a phrase seeks the video.
- If this session has an open engagement (active assignment), the positional target argument is unnecessary — the CLI resolves the target from the engagement. Otherwise pass `--project <slug> <assignment-slug>` or a bare assignment UUID.

The CLI copies the file (if any) under `<assignmentDir>/proof/<criterion|untagged>/<id>.<ext>` and inserts a row in `~/.syntaur/syntaur.db`. Output prints the artifact id and absolute path.

## Step 4: Optional — refresh the proof page

```bash
syntaur proof build [--project <slug> <assignment-slug>]
```

This walks `## Acceptance Criteria` and renders `proof.html` + `proof.md` at the assignment dir, embedding tagged artifacts inline beneath their criteria and untagged/stale ones in a final "Other artifacts" section. Atomic overwrite — safe to re-run after every capture, or once at completion. The rendered page works in any browser; no desktop-app dependency.

The `complete-assignment` skill mentions the proof page path in its final report so the reviewer can open it.

## Step 5: Record the capture (per `keep-records-updated` playbook)

The `keep-records-updated` playbook recommends running `syntaur capture` whenever the change is visually or behaviorally observable. Append a brief mention to `progress.md` if it adds context (e.g. "captured login-flow video against criterion 2"). Skipping a capture is fine — proof is opt-in for v1; there is no completion gate.

## Notes

- Artifacts are local-only in v1. Cloud upload is not available.
- Stale `criterion_index` (e.g. when a criterion is later deleted or reordered) renders under "Other artifacts" with a "(was tagged criterion N — no longer present)" annotation. The artifact is not lost.
- Storage stays out of git by default — `~/.syntaur/` is outside any tracked tree.
