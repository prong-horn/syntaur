---
assignment: implement-jwt-middleware
status: approved
created: "2026-03-15T09:30:00Z"
updated: "2026-03-17T10:30:00Z"
---

# Plan: Implement JWT Authentication Middleware

## Approach

Build the JWT authentication layer as Express middleware. Use RS256 asymmetric signing so that services can verify tokens with the public key without access to the private key. Integrate with the PostgreSQL schema from design-auth-schema for session and refresh token storage.

## Tasks

- [x] Set up RS256 key pair loading from environment variables
- [x] Implement `generateAccessToken(user, sessionId)` — signs JWT with private key, includes jti, sub, role, exp
- [x] Implement `generateRefreshToken(user)` — creates refresh token record in database with token_family
- [x] Create login endpoint (`POST /auth/login`) — validates credentials, creates session, returns tokens
- [x] Create signup endpoint (`POST /auth/signup`) — creates user, creates session, returns tokens
- [x] Implement `authenticateToken` middleware — extracts Bearer token, verifies RS256 signature, checks session
- [x] Implement `requireRole(role)` middleware — checks user role from JWT claims
- [ ] Implement refresh endpoint (`POST /auth/refresh`) — validates refresh token, rotates, returns new pair
- [ ] Implement logout endpoint (`POST /auth/logout`) — revokes session and token family
- [ ] Add rate limiting to auth endpoints

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Key rotation complexity with RS256 | Support JWKS endpoint for key discovery in v2; for now, single key pair loaded at startup |
| Refresh token theft | Use token family rotation — if an old token is reused, revoke the entire family |
| Clock skew causing premature expiry | Add 30-second leeway to token validation |
