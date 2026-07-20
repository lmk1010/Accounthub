# Privacy (self-hosted)

AccountHub is software you run on infrastructure **you** control.  
This page describes data the software *can* process and recommendations for responsible operation. It is **not** a privacy policy for a hosted SaaS operated by the maintainers (the maintainers do not operate your instance).

## Roles

| Role | Who |
|------|-----|
| Software authors | AccountHub contributors (publish code) |
| Operator / admin | You (deploy and configure the instance) |
| End users | People who call your gateway or admin UI |

If you deploy AccountHub, **you** determine purposes of processing and legal bases under privacy law.

## Data the software may process

Depending on configuration, AccountHub may store or process:

1. **Admin credentials** — admin password hashes, session tokens  
2. **Provider credentials** — OAuth refresh/access tokens, API keys, account emails embedded in tokens  
3. **Operational metadata** — provider health, pool membership, error counters  
4. **Request logs** (if enabled) — timestamps, model names, token usage, client IPs, user agents, optional user identifiers from gateways  
5. **Usage statistics** — cache/read token aggregates, success/failure rates  

Prompt/response bodies may be logged only if you enable verbose prompt logging. **Keep that off** unless you have a clear research need and retention policy.

## Data the maintainers do not receive

A default self-host install does **not** phone home to AccountHub authors.  
Telemetry to third parties only happens if **you** configure external services (proxies, cloud DBs, analytics, etc.).

## Recommendations for operators

1. **Minimize** — disable prompt body logging; shorten request-log retention  
2. **Protect** — TLS at reverse proxy; strong `REQUIRED_API_KEY`; never expose admin UI publicly without auth  
3. **Segregate** — separate DB users, network policies, and backups with encryption  
4. **Access control** — few admin accounts; audit password changes  
5. **Retention** — purge old `request_logs` and tokens on a schedule  
6. **Secrets** — use env/secret managers; never commit `.env`  
7. **Subprocessors** — if you put MySQL/Redis on a cloud vendor, their DPA applies to you as customer  

## End-user notice

If third parties call your AccountHub-backed API, provide them your own privacy notice covering:

- what you log  
- retention  
- whether prompts are stored  
- contact for data requests  

AccountHub cannot generate that notice for your business automatically.

## Cookies / local storage

The admin UI may store session tokens in browser `localStorage` / cookies for authentication.  
That data stays in the admin’s browser and your server — not with project maintainers.

## Changes

Operators should re-review this document when upgrading.  
Legal requirements depend on your jurisdiction and use case; obtain counsel if unsure.
