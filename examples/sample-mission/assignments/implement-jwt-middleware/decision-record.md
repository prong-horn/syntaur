---
assignment: implement-jwt-middleware
updated: 2026-03-17T11:00:00Z
decisionCount: 1
---

# Decision Record

## Decision 1: Use RS256 for JWT signing

**Date:** 2026-03-17T11:00:00Z
**Status:** accepted
**Context:** Need to choose a JWT signing algorithm. Options: HS256 (symmetric, shared secret) or RS256 (asymmetric, public/private key pair). Future services may need to verify tokens without being able to create them.
**Decision:** Use RS256 asymmetric signing. The auth service holds the private key; other services only need the public key to verify tokens.
**Consequences:** Slightly more complex key management (two keys instead of one). Larger token size (~800 bytes vs ~300 bytes for HS256). Enables future JWKS endpoint for automated key discovery. Supports key rotation without redeploying all verifying services.
