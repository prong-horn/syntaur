---
name: "Plan Versioning"
slug: plan-versioning
description: "When plans change mid-flight, document what changed and why instead of silently rewriting"
when_to_use: "When modifying an existing plan that is already in_progress"
created: "2026-04-02T00:00:00Z"
updated: "2026-04-02T00:00:00Z"
tags:
  - planning
  - protocol
---

# Plan Versioning

When you need to change a plan that's already `in_progress`:

1. Do NOT silently rewrite the plan. Add a revision section:

```
## Revision N -- <date>

**Reason:** <why the plan changed>

**What changed:**
- <specific changes>

**Completed before revision:**
- [x] <tasks already done>
```

2. Then update the task list to reflect the new plan.

This matters because:
- Handoff notes reference plan steps by description -- silent rewrites break that
- The human reviewing the assignment needs to understand why the approach shifted
- decision-record.md should get a corresponding entry for significant plan changes
