# Security Policy

## Supported versions

Security fixes are applied on the active development branch (`develop_new` / `main` as published).

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Report privately to the repository maintainers (GitHub Security Advisory or private contact listed on the org). Include:

- affected component (backend route, provider adapter, admin API)
- reproduction steps
- impact assessment

We will acknowledge reports as soon as practical and coordinate disclosure.

## Operational guidance

- Never commit real `.env` files, API keys, OAuth tokens, or database passwords.
- Rotate any credentials that ever appeared in git history before a public release.
- Prefer official provider APIs and OAuth flows; treat experimental adapters as unsupported for production.
- Admin UI and management APIs must not be exposed to the public internet without authentication and network controls.
- AccountHub manages **provider accounts**. End-user billing/auth belongs in your gateway (e.g. NewAPI), not in this service’s default threat model.

## Scope notes

AccountHub is infrastructure software. Misconfiguration (open admin, weak `REQUIRED_API_KEY`, public OAuth callback without TLS) is an operator risk. Hardening checklists belong in deployment docs.
