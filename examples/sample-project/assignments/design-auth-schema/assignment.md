---
id: d1e2f3a4-b5c6-7890-abcd-111111111111
slug: design-auth-schema
title: Design Auth Database Schema
project: build-auth-system
type: feature
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

## Links

- [Progress](./progress.md)
- [Comments](./comments.md)
- [Scratchpad](./scratchpad.md)
- [Handoff](./handoff.md)
- [Decision Record](./decision-record.md)
