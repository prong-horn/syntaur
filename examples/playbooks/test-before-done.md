---
name: "Test Before Done"
slug: test-before-done
description: "Agents must run tests and verify acceptance criteria before marking assignments complete"
when_to_use: "Before transitioning an assignment to review or completed"
created: "2026-04-02T00:00:00Z"
updated: "2026-04-02T00:00:00Z"
tags:
  - quality
  - testing
---

# Test Before Done

Before transitioning an assignment to `review` or `completed`:

1. **Run the test suite.** If the project has tests, run them. All must pass.
2. **Check every acceptance criterion.** Go through them one by one. Each must be demonstrably met -- not "should work" but actually verified.
3. **Build the project.** If there's a build step, run it. No build errors allowed.
4. **Check for regressions.** If you modified existing code, verify the existing behavior still works.

If any criterion can't be verified (e.g., requires manual UI testing), note this explicitly in the handoff rather than silently skipping it.

Do NOT mark an assignment complete just because you wrote the code. Completion means verified, not just implemented.
