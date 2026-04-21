---
type: memory
name: PostgreSQL Connection Pooling
source: claude-2
sourceAssignment: design-auth-schema
relatedAssignments:
  - design-auth-schema
  - implement-jwt-middleware
scope: project
created: "2026-03-17T09:00:00Z"
updated: "2026-03-17T09:00:00Z"
tags:
  - postgresql
  - performance
---

# PostgreSQL Connection Pooling

## Context

During schema design and migration testing, discovered that the default `pg` driver behavior of creating a new connection per query causes significant overhead under load. This is especially relevant for the auth system where every protected request hits the database to check session validity.

## Learnings

1. **Use `pg.Pool` instead of `pg.Client`:** The Pool manages a set of reusable connections. Set `max: 20` to match the non-functional requirement. The pool handles connection checkout, return, and idle timeout automatically.

2. **Set `idleTimeoutMillis: 30000`:** Connections idle for more than 30 seconds are closed. This prevents holding connections during low-traffic periods while keeping them warm during bursts.

3. **Set `connectionTimeoutMillis: 5000`:** If no connection is available within 5 seconds, fail fast rather than queue indefinitely. The auth middleware should return 503 in this case.

4. **Pool per service, not per request:** Create the pool once at application startup and share it across all routes. Confirmed that `pg.Pool` is safe for concurrent use.

## Recommendation

Add pool configuration to the service initialization code before the JWT middleware work begins. The middleware will need the pool for session lookups on every authenticated request.
