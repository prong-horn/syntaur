---
id: d1e2f3a4-b5c6-7890-abcd-111111111111
slug: design-auth-schema
title: Design Auth Database Schema
status: completed
priority: high
created: "2026-03-15T09:30:00Z"
updated: "2026-03-17T10:00:00Z"
assignee: claude-2
externalIds: []
dependsOn: []
blockedReason: null
workspace:
  repository: /Users/brennen/projects/auth-service
  worktreePath: /Users/brennen/projects/auth-service-worktrees/design-auth-schema
  branch: feat/auth-schema
  parentBranch: main
tags: []
---

# Design Auth Database Schema

## Objective

Design the PostgreSQL database schema for the authentication system. This includes tables for users, sessions, and refresh tokens, with appropriate indexes, constraints, and migration scripts.

## Acceptance Criteria

- [x] Users table with email, password hash, roles, and timestamps
- [x] Sessions table with token references, expiry, and revocation support
- [x] Refresh tokens table with rotation tracking
- [x] All tables have appropriate indexes for query patterns
- [x] Migration scripts are idempotent and backward-compatible

## Todos

- [x] Execute [plan](./plan.md)

## Context

This is the foundational data layer for the auth system. The schema must support the JWT middleware (implement-jwt-middleware) and be testable (write-auth-tests). See [Auth Requirements](../../resources/auth-requirements.md) for functional specs.

## Questions & Answers

### Q: Should we use UUIDs or auto-incrementing integers for user IDs?
**Asked:** 2026-03-16T10:00:00Z
**A:** Use UUIDs (v4). They avoid enumeration attacks and simplify future sharding. Generate them in the application layer, not the database.

## Progress

### 2026-03-17T10:00:00Z
Completed all migration scripts and schema design. Final schema includes three tables: `users`, `sessions`, and `refresh_tokens`. Added composite index on `sessions(user_id, revoked_at)` for the active-session lookup query. All migrations tested against a clean database. Ready for handoff to JWT middleware implementation.

### 2026-03-16T14:00:00Z
Draft schema complete for users and sessions tables. Working on refresh token rotation tracking. Decided to add a `token_family` column to detect reuse of old refresh tokens.

### 2026-03-16T09:30:00Z
Started schema design. Reviewed auth requirements document. Planning three tables: users, sessions, refresh_tokens.

## Links

- [Scratchpad](./scratchpad.md)
- [Handoff](./handoff.md)
- [Decision Record](./decision-record.md)
