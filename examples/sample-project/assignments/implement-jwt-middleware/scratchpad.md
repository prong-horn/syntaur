---
assignment: implement-jwt-middleware
updated: "2026-03-18T14:30:00Z"
---

# Scratchpad

## Token structure

Access token claims:
```json
{
  "sub": "user-uuid",
  "jti": "session-uuid",
  "role": "user",
  "iat": 1742300000,
  "exp": 1742301800
}
```
- Access token TTL: 30 minutes
- Refresh token TTL: 7 days

## Key loading

Keys loaded from env vars:
- `JWT_PRIVATE_KEY` — PEM-encoded RS256 private key (base64 in env, decoded at startup)
- `JWT_PUBLIC_KEY` — PEM-encoded RS256 public key (base64 in env, decoded at startup)

Verified this works with `jsonwebtoken` library v9. The `algorithm: 'RS256'` option is required on both sign and verify.

## Middleware chain

```
authenticateToken -> extracts token -> verifies signature -> checks session in DB -> attaches user to req
requireRole('admin') -> checks req.user.role -> 403 if mismatch
```

## Open question

Refresh endpoint: should it require the expired access token along with the refresh token? This provides an extra binding between the two tokens but adds complexity for the client. Asked in Q&A, waiting for answer.

## Files created so far

- `src/middleware/authenticate.ts` — authenticateToken middleware
- `src/middleware/requireRole.ts` — role guard middleware
- `src/routes/auth.ts` — login and signup endpoints
- `src/utils/jwt.ts` — generateAccessToken, generateRefreshToken, verifyToken
- `src/utils/keys.ts` — key loading from environment
