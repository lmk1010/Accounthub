# Contributing to AccountHub

Thanks for helping improve AccountHub.

## Project identity

Please read [NOTICE.md](NOTICE.md) and [docs/public/RESEARCH_USE.md](docs/public/RESEARCH_USE.md) before contributing features that automate account creation or unofficial provider access.


- Product name: **AccountHub**
- Not affiliated with AIClient or similarly named projects
- Focus: multi-account OAuth pools + protocol gateway (not a chat UI, not end-user billing)

## Development

```bash
# Backend
cd backend && cp .env.example .env.development && npm install && npm run start:dev

# Frontend
cd frontend && cp .env.example .env.development && npm install && npm run dev
```

## Pull requests

- Keep changes scoped and tested
- Do not commit secrets, capture dumps, or private ops/profit docs
- Prefer official provider APIs; mark experimental adapters clearly
- Match existing code style in the area you touch

## Security

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).
