# AccountHub — Research & Self-Host Use Notice

## Purpose

AccountHub is open-source infrastructure software intended for:

- learning how multi-provider AI account pools and protocol gateways work
- research on routing, OAuth lifecycle, health checks, and protocol conversion
- **authorized** self-hosted experiments on systems and credentials **you own or are permitted to use**

It is **not** a service that sells or provides third-party AI accounts, paid quotas, or access to any vendor API.

## Your responsibilities

By downloading, deploying, or operating AccountHub **you alone** are responsible for:

1. **Provider Terms of Service**  
   Comply with OpenAI, Anthropic, Google, xAI, and every other upstream provider’s terms, policies, and rate limits.

2. **Authorization**  
   Use only API keys, OAuth grants, and accounts you are legally allowed to use. Do not import stolen, shared-in-violation, or scraped credentials.

3. **No circumvention**  
   Do not use this software to bypass payment, plan limits, security controls, or access restrictions you are not entitled to.

4. **Privacy & data protection**  
   If you process personal data (emails, tokens, logs, user identifiers), you must have a lawful basis, minimize data, secure it, and honor applicable privacy laws (e.g. GDPR/CCPA where they apply).

5. **Security of your deployment**  
   Do not expose the admin UI or management APIs to the public internet without authentication, TLS, and network controls. Rotate secrets. Keep dependencies updated.

6. **Local law**  
   Export controls, computer misuse, anti-fraud, and consumer protection laws vary by jurisdiction. You must comply with the laws that apply to you.

## Explicitly out of scope / discouraged

AccountHub’s maintainers **do not support** and **do not encourage**:

- bulk automated registration against provider rules (“account farms”)
- credential stuffing, token theft, or resale of access
- operating an unauthorized commercial proxy that misrepresents itself as an official vendor product
- any activity intended to defraud providers or end users

Some optional or experimental adapters may interact with unofficial endpoints. Those paths are **experimental**, may break, and may conflict with provider terms. Prefer **official APIs and documented OAuth** whenever possible. Disable experimental adapters if you are unsure.

## No warranty

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND. See [LICENSE](../LICENSE).  
Maintainers are not liable for bans, data loss, legal claims, or damages arising from your use of the software.

## Reporting abuse or security issues

- Security vulnerabilities: see [SECURITY.md](../SECURITY.md)
- If you believe a public deployment is causing harm, contact the operator of that deployment and, where appropriate, the relevant provider’s abuse channel

## Summary

**AccountHub is a tool.**  
How you use it is your decision and your liability.  
Use it for learning, research, and authorized self-hosting — not for unauthorized access or ToS abuse.
