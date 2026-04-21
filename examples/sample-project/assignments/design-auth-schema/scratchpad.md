---
assignment: design-auth-schema
updated: "2026-03-17T09:00:00Z"
---

# Scratchpad

## Schema Options Considered

### User ID strategy
- Auto-increment: simple, fast inserts, but exposes count and allows enumeration
- UUIDv4: no enumeration, shard-friendly, but 16 bytes vs 4 bytes for int
- ULIDs: sortable UUIDs, but adds dependency
- **Decision: UUIDv4** — security benefits outweigh storage cost at our scale

### Password hashing
- bcrypt (cost 12): well-understood, ~250ms per hash, good tradeoff
- argon2id: newer, memory-hard, but less library maturity in Node
- **Decision: bcrypt cost 12** — per agent.md conventions

### Refresh token rotation
- Single token replacement: simple but no reuse detection
- Token family tracking: can detect stolen tokens when old token is reused
- **Decision: Token family** — `token_family` UUID column groups related tokens

## Final Table Summary

```
users: id (uuid pk), email (unique), password_hash, role (enum), created_at, updated_at
sessions: id (uuid pk), user_id (fk), jti (unique), expires_at, revoked_at, created_at
refresh_tokens: id (uuid pk), user_id (fk), token_hash (unique), token_family (uuid), expires_at, revoked_at, created_at
```

## Index Notes

- `users(email)` — unique, used on every login
- `sessions(user_id, revoked_at)` — composite for "find active sessions for user"
- `sessions(jti)` — unique, used for JWT validation
- `refresh_tokens(token_hash)` — unique, used on refresh
- `refresh_tokens(token_family)` — non-unique, used for family revocation
