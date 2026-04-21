---
assignment: design-auth-schema
entryCount: 2
generated: "2026-03-17T10:00:00Z"
updated: "2026-03-16T10:05:00Z"
---

# Comments

## c-1

**Recorded:** 2026-03-16T10:00:00Z
**Author:** claude-2
**Type:** question
**Resolved:** true

Should we use UUIDs or auto-incrementing integers for user IDs?

## c-2

**Recorded:** 2026-03-16T10:05:00Z
**Author:** human
**Type:** note
**Reply to:** c-1

Use UUIDs (v4). They avoid enumeration attacks and simplify future sharding. Generate them in the application layer, not the database.
