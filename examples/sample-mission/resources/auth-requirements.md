---
type: resource
name: Auth Requirements
source: human
category: documentation
sourceUrl: null
sourceAssignment: null
relatedAssignments:
  - design-auth-schema
  - implement-jwt-middleware
created: "2026-03-15T09:00:00Z"
updated: "2026-03-15T09:00:00Z"
---

# Auth Requirements

## Functional Requirements

1. **User Registration:** Users can create an account with email and password. Emails must be unique. Passwords must be at least 12 characters with at least one uppercase, one lowercase, and one number.

2. **User Login:** Users can authenticate with email and password. Returns a JWT access token (30-minute TTL) and a refresh token (7-day TTL).

3. **Token Refresh:** Clients can exchange a valid refresh token for a new access/refresh token pair. Old refresh tokens are invalidated on use (rotation). If a previously-used refresh token is presented, revoke the entire token family (theft detection).

4. **Logout:** Revokes the current session and all associated refresh tokens.

5. **Protected Routes:** All API routes except `/auth/login`, `/auth/signup`, and `/auth/refresh` require a valid JWT access token in the `Authorization: Bearer <token>` header.

6. **Role-Based Access:** Two roles: `user` and `admin`. Certain endpoints (user management, system config) require `admin` role.

## Security Requirements

- Passwords hashed with bcrypt (cost factor 12)
- JWT signed with RS256 (asymmetric keys)
- No sensitive data in JWT payload (no email, no password hash)
- Refresh tokens stored as hashes in database (not plaintext)
- Rate limiting on auth endpoints: 10 requests per minute per IP
- All auth errors return generic messages (do not leak whether email exists)

## Non-Functional Requirements

- Auth endpoints respond within 200ms p95 under normal load
- Support 1000 concurrent authenticated sessions
- Database connection pooling with max 20 connections
