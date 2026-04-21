---
id: d1e2f3a4-b5c6-7890-abcd-222222222222
slug: implement-jwt-middleware
title: Implement JWT Authentication Middleware
project: build-auth-system
type: feature
status: in_progress
priority: high
created: "2026-03-15T09:30:00Z"
updated: "2026-03-18T14:30:00Z"
assignee: claude-1
externalIds:
  - system: jira
    id: AUTH-43
    url: https://jira.example.com/browse/AUTH-43
dependsOn:
  - design-auth-schema
blockedReason: null
workspace:
  repository: /Users/brennen/projects/auth-service
  worktreePath: /Users/brennen/projects/auth-service-worktrees/implement-jwt-middleware
  branch: feat/jwt-middleware
  parentBranch: main
tags: []
---

# Implement JWT Authentication Middleware

## Objective

Implement Express.js middleware that validates JWT access tokens on protected routes. Use RS256 signing with public/private key pairs. Include token generation for login/signup endpoints and a refresh token flow.

## Acceptance Criteria

- [x] JWT generation with RS256 signing on login and signup
- [x] Middleware that validates JWT on protected routes
- [ ] Refresh token endpoint with rotation and family-based revocation
- [ ] Token revocation endpoint (logout)
- [ ] Role-based route guards (admin vs user)

## Todos

- [ ] Execute [plan](./plan.md)

## Context

Depends on the database schema from [design-auth-schema](../design-auth-schema/assignment.md). The schema is complete — see the [handoff notes](../design-auth-schema/handoff.md) for integration details. Key table: `sessions` with `jti` column for token validation. See [Auth Requirements](../../resources/auth-requirements.md) for full specs.

## Links

- [Progress](./progress.md)
- [Comments](./comments.md)
- [Scratchpad](./scratchpad.md)
- [Handoff](./handoff.md)
- [Decision Record](./decision-record.md)
