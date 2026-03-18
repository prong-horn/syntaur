# Claude Code Instructions — build-auth-system

Read `agent.md` first for universal conventions and boundaries.

## Additional Claude Code Rules

- When creating new files, always add them to the appropriate barrel export (`index.ts`)
- Run `npm run typecheck` after making changes to catch type errors early
- Use `npm test -- --watch` during development for fast feedback
- Prefer explicit type annotations on function signatures over inference
- When writing SQL migrations, name files with sequential numbering: `001_create_users.sql`, `002_create_sessions.sql`, etc.
- Commit frequently with descriptive messages referencing the assignment slug
- If you encounter a question you cannot resolve from existing context, add it to the Q&A section of your assignment.md and continue working on other tasks — the unanswered question will surface through `_status.md` needsAttention. Do NOT set status to `blocked` for unanswered questions; `blocked` is reserved for hard runtime/manual blockers.
