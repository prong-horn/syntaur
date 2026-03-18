---
id: d1e2f3a4-b5c6-7890-abcd-222222222222
slug: implement-jwt-middleware
title: Implement JWT Authentication Middleware
status: in_progress
priority: high
created: 2026-03-15T09:30:00Z
updated: 2026-03-18T14:30:00Z
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

## Context

Depends on the database schema from [design-auth-schema](../design-auth-schema/assignment.md). The schema is complete — see the [handoff notes](../design-auth-schema/handoff.md) for integration details. Key table: `sessions` with `jti` column for token validation. See [Auth Requirements](../../resources/auth-requirements.md) for full specs.

## Sessions

| Session ID | Agent | Started | Ended | Status |
|------------|-------|---------|-------|--------|
| tmux:syntaur-jwt-1 | claude-1 | 2026-03-17T10:30:00Z | null | active |

## Questions & Answers

### Q: Should the refresh token endpoint require the old access token or just the refresh token?
**Asked:** 2026-03-18T11:00:00Z
**A:** pending

## Progress

### 2026-03-18T14:30:00Z
Implemented role-based route guard middleware (`requireRole`). Working on the refresh token endpoint next. The token generation and basic validation middleware are working and passing manual tests. Need to wire up the refresh token rotation logic using the `token_family` pattern from the schema design.

### 2026-03-18T10:00:00Z
JWT validation middleware is functional. It extracts the token from the Authorization header, verifies the RS256 signature, checks expiry, and looks up the `jti` in the sessions table to confirm the session is not revoked. Added proper error responses for expired, invalid, and revoked tokens.

### 2026-03-17T10:30:00Z
Started implementation. Set up RS256 key pair loading from environment variables. Implemented `generateAccessToken` and `generateRefreshToken` functions. Created the login endpoint that authenticates with bcrypt and returns both tokens.

## Links

- [Plan](./plan.md)
- [Scratchpad](./scratchpad.md)
- [Handoff](./handoff.md)
- [Decision Record](./decision-record.md)
