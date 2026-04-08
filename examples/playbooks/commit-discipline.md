---
name: "Commit Discipline"
slug: commit-discipline
description: "Make small, logical commits with clear messages tied to plan tasks"
when_to_use: "When making git commits during assignment work"
created: "2026-04-02T00:00:00Z"
updated: "2026-04-02T00:00:00Z"
tags:
  - quality
  - git
---

# Commit Discipline

- Make commits at logical boundaries -- one commit per plan task or meaningful unit of work, not one giant commit at the end.
- Commit messages should reference what was done, not just "implement feature."
- If the assignment has an external ID (e.g., a ticket number), include it in commit messages.
- Never commit secrets, credentials, .env files, or API keys.
- Run the linter/formatter before committing if the project has one configured.
- Do not amend previous commits unless explicitly asked. Create new commits.
