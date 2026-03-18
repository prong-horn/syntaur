---
assignment: write-auth-tests
status: draft
created: "2026-03-15T09:30:00Z"
updated: "2026-03-15T09:30:00Z"
---

# Plan: Write Auth System Tests

## Approach

Write a layered test suite: unit tests for isolated functions (JWT utils, middleware with mocked dependencies), integration tests for full endpoint flows (login, signup, refresh, logout), and edge case tests for security-critical paths (token expiry, revocation, refresh reuse).

## Tasks

- [ ] Set up test infrastructure (Jest config, test database, fixtures)
- [ ] Unit tests for `generateAccessToken` and `generateRefreshToken`
- [ ] Unit tests for `verifyToken` with valid, expired, and malformed tokens
- [ ] Unit tests for `authenticateToken` middleware with mocked DB
- [ ] Unit tests for `requireRole` middleware
- [ ] Integration tests for `POST /auth/signup` (happy path, duplicate email, weak password)
- [ ] Integration tests for `POST /auth/login` (happy path, wrong password, nonexistent user)
- [ ] Integration tests for `POST /auth/refresh` (happy path, expired token, reused token)
- [ ] Integration tests for `POST /auth/logout` (revokes session and token family)
- [ ] Integration tests for role-based route protection
- [ ] Generate and verify coverage report

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Test database setup complexity | Use Docker Compose for isolated PostgreSQL instance; reset between test suites |
| Flaky tests from timing-dependent JWT expiry | Use deterministic clock mocking with Jest fake timers |
| Incomplete coverage of edge cases | Review OWASP auth testing checklist before writing tests |
