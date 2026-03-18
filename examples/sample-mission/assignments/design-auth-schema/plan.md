---
assignment: design-auth-schema
status: completed
created: 2026-03-15T09:30:00Z
updated: 2026-03-17T10:00:00Z
---

# Plan: Design Auth Database Schema

## Approach

Design a normalized PostgreSQL schema supporting user authentication, session management, and refresh token rotation. Write idempotent migration scripts that can be run in sequence. Prioritize query performance for the hot paths: login, token validation, and session lookup.

## Tasks

- [x] Review auth requirements and identify all entities
- [x] Design users table with email uniqueness, password hash, role enum, timestamps
- [x] Design sessions table with JWT reference, expiry tracking, revocation
- [x] Design refresh_tokens table with token family for rotation detection
- [x] Add indexes for common query patterns (email lookup, active sessions, token lookup)
- [x] Write migration scripts (001_create_users.sql, 002_create_sessions.sql, 003_create_refresh_tokens.sql)
- [x] Test migrations against clean database
- [x] Document schema in scratchpad for handoff

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Schema changes after JWT middleware is built | Design for flexibility — use nullable columns where future additions are likely |
| Performance at scale for session lookups | Add composite index on (user_id, revoked_at) and set up EXPLAIN ANALYZE benchmarks |
| Migration ordering issues | Number migrations sequentially and test from clean state |
