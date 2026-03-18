---
assignment: design-auth-schema
updated: 2026-03-16T11:00:00Z
decisionCount: 1
---

# Decision Record

## Decision 1: Use PostgreSQL for user store

**Date:** 2026-03-16T11:00:00Z
**Status:** accepted
**Context:** The auth system needs a persistent store for users, sessions, and refresh tokens. Options considered were PostgreSQL, MySQL, and MongoDB. The rest of the platform already uses PostgreSQL for other services.
**Decision:** Use PostgreSQL 16 as the sole datastore for the auth system. No additional databases or caches for v1.
**Consequences:** Simplifies operations (single database to manage). We get ACID transactions for token rotation. May need to add Redis for session caching later if lookup latency becomes an issue, but premature for v1.
