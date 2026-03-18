---
id: a1b2c3d4-e5f6-7890-abcd-ef1234567890
slug: build-auth-system
title: Build Authentication System
archived: false
archivedAt: null
archivedReason: null
created: "2026-03-15T09:00:00Z"
updated: "2026-03-15T09:00:00Z"
externalIds:
  - system: jira
    id: AUTH-42
    url: https://jira.example.com/browse/AUTH-42
tags: []
---

# Build Authentication System

## Overview

Build a complete authentication system for the auth-service backend. This includes designing the PostgreSQL schema for users, sessions, and tokens, implementing JWT-based middleware for route protection using RS256 signing, and writing comprehensive integration and unit tests.

The system must support:
- User registration and login with email/password
- JWT access tokens (short-lived) and refresh tokens (long-lived)
- Session management with revocation support
- Role-based access control (RBAC) with admin and user roles

Success looks like: all auth endpoints are functional, middleware protects routes correctly, token refresh flow works end-to-end, and test coverage exceeds 80%.

## Notes

The auth service is a greenfield project. We are using Express.js with TypeScript on Node 20. PostgreSQL 16 is the datastore. The team decided to use RS256 for JWT signing to support future key rotation without service restarts.
