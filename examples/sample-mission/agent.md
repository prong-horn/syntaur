---
mission: build-auth-system
updated: "2026-03-15T09:00:00Z"
---

# Agent Instructions

All agents working on the auth system must follow these guidelines. These apply regardless of which agent framework you are using.

## Conventions

- Language: TypeScript (strict mode enabled)
- Runtime: Node.js 20
- Database: PostgreSQL 16 with the `pg` driver (no ORM)
- Authentication: JWT with RS256 signing algorithm
- Password hashing: bcrypt with cost factor 12
- Use named exports, not default exports
- All database queries must use parameterized statements (no string interpolation)
- Error responses follow the format: `{ error: string, code: string }`

## Boundaries

- Do not modify the `infrastructure/` directory — deployment config is managed separately
- Do not install additional database drivers or ORMs
- Do not change the JWT signing algorithm without filing a decision record
- All schema migrations must be backward-compatible
- Never store plaintext passwords or secrets in code

## Resources

- [Auth Requirements](./resources/auth-requirements.md) — functional and security requirements
- PostgreSQL 16 docs: https://www.postgresql.org/docs/16/
- JWT RFC 7519: https://datatracker.ietf.org/doc/html/rfc7519
