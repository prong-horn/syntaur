---
name: "Read Before You Plan"
slug: read-before-plan
description: "Agents must read all project context files before creating or modifying a plan"
when_to_use: "Before creating or modifying any plan file (plan.md, plan-v2.md, ...)"
created: "2026-04-02T00:00:00Z"
updated: "2026-04-20T00:00:00Z"
tags:
  - protocol
  - planning
---

# Read Before You Plan

Before creating or modifying any plan file (plan.md, plan-v2.md, ...), read these files in order:

For project-nested assignments:
1. `manifest.md` -- understand the project structure
2. `project.md` -- understand the goal and scope
3. `assignment.md` -- understand your specific task, acceptance criteria, and dependencies. Frontmatter includes `project: <slug> | null` and `type: <classification> | null`.
4. `progress.md` (if exists) -- reverse-chron log of what has been done on this assignment
5. `comments.md` (if exists) -- open questions, notes, and feedback
6. `handoff.md` (if exists) -- understand what previous agents did and learned
7. `decision-record.md` (if exists) -- understand past decisions and their rationale

For standalone assignments (at `~/.syntaur/assignments/<uuid>/`), skip `manifest.md` and `project.md` — those only exist for project-nested assignments.

Do NOT skip files because you think you know what's in them. Context from prior agents is often critical.

If the assignment has `dependsOn` entries, read those assignments too -- and read **their** `decision-record.md` first. Upstream decisions are binding constraints you must not silently contradict. (The grab-assignment skill auto-loads these.)
