<div align="center">

<img src="docs/public/accounthub-mark.svg" alt="AccountHub" width="96" height="96" />

# AccountHub

**Multi-account OAuth pool & protocol gateway for AI providers**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/docker-ready-blue.svg)](https://www.docker.com)

[Features](#features) · [Supported protocols](#supported-protocols--providers) · [Pricing calculator](#pricing-calculator-mid-price--break-even) · [Quick Start](#quick-start) · [One-click install](#one-click-install) · [Docker](#docker) · [Research use](#research-use--disclaimer)

</div>

---

## What is AccountHub?

AccountHub is a **control plane for AI provider accounts**:

- manage OAuth / API credentials across many accounts
- pool, route, and health-check them
- expose **OpenAI-compatible** and **Anthropic-compatible** endpoints
- normalize usage (including cache tokens) for upstream gateways

It is **not** a chat UI and **not** a user-billing panel.  
It sits **upstream of** API gateways (for example NewAPI): AccountHub owns accounts & protocols; the gateway owns end users & billing.

> **Independent project.** AccountHub is not affiliated with, branded as, or a continuation of any project named AIClient. That is a separate codebase and product line.
>
> **Research / self-host oriented.** Provided for learning, research, and authorized experiments. You must comply with provider Terms of Service and law. See [NOTICE.md](NOTICE.md), [docs/public/RESEARCH_USE.md](docs/public/RESEARCH_USE.md), and [docs/public/PRIVACY.md](docs/public/PRIVACY.md).

---



## Screenshots

<p align="center">
  <img src="docs/public/screenshots/01-login.png" alt="Login" width="48%" />
  <img src="docs/public/screenshots/02-dashboard.png" alt="Dashboard" width="48%" />
</p>
<p align="center">
  <img src="docs/public/screenshots/03-providers.png" alt="Providers" width="48%" />
  <img src="docs/public/screenshots/04-provider-detail.png" alt="Provider detail" width="48%" />
</p>
<p align="center">
  <img src="docs/public/screenshots/07-monitor.png" alt="Monitor" width="48%" />
  <img src="docs/public/screenshots/05-logs.png" alt="Logs" width="48%" />
</p>

## Features

- **Account pools** — health checks, cooldowns, sticky sessions, concurrency limits
- **Multi-provider** — OpenAI-family, Anthropic-compatible, Gemini-family, xAI Grok, and more
- **OAuth lifecycle** — import, refresh, lock, multi-account rotation
- **Protocol bridge** — Claude Messages ↔ OpenAI Chat / Responses ↔ provider-native APIs
- **Channel config** — default models, routing, provider-level switches (e.g. Grok API vs Build)
- **Ops console** — React admin for pools, accounts, logs, and usage
- **Database-backed** — MySQL for credentials, pools, and request stats
- **Pricing calculator** — pool cost / utilization / mid-price & break-even worksheet (operator tool)

---

## Architecture

```
                    ┌──────────────────────┐
  Clients / Gateways│  OpenAI / Anthropic  │
  (SDK, NewAPI, …)  │  compatible HTTP     │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │     AccountHub       │
                    │  pool · route · auth │
                    │  protocol convert    │
                    └──────────┬───────────┘
               ┌───────────────┼───────────────┐
               ▼               ▼               ▼
          Provider A      Provider B      Provider C
          (OAuth pool)    (OAuth pool)    (API keys)
```

| Layer | Responsibility |
|-------|----------------|
| Frontend | Admin console (React) |
| Backend | Gateway, pools, OAuth, converters |
| MySQL | Accounts, pools, channel config, request logs |
| Redis (optional) | Sticky sessions, concurrency, sharding |

---



## Supported protocols & providers

AccountHub speaks **client-facing** protocols and routes them to **provider pools**.

### Client protocols (inbound)

| Protocol | Typical paths | Notes |
|----------|---------------|--------|
| **OpenAI Chat Completions** | `POST /v1/chat/completions` | Common gateway default |
| **OpenAI Responses** | `POST /v1/responses`, `POST /v1/responses/compact` | Codex / Responses-style clients |
| **Anthropic Messages** | `POST /v1/messages` | Claude Code / Anthropic SDKs |
| **Models** | `GET /v1/models` | OpenAI-compatible listing |
| **Media (where enabled)** | `/v1/images/*`, `/v1/videos/*` | Provider-dependent |

You can also prefix routes with a provider type when your gateway routes per channel, e.g. `/openai-xai-oauth/v1/chat/completions`.

Auth for the gateway → AccountHub hop uses your configured **`REQUIRED_API_KEY`** (`Authorization: Bearer …` / `x-api-key` style headers depending on client).

### Provider channels (outbound pools)

The admin console manages multi-account pools. Public UI highlights commonly used channels (others may remain in code as experimental):

| Channel key | Role |
|-------------|------|
| `openai-codex` | OpenAI Codex OAuth pool |
| `openai-xai-oauth` | xAI Grok OAuth (API / Build path switch) |
| `claude-kiro-oauth` / `claude-custom` / `claude-offical` | Claude-family routes |
| `gemini-cli-oauth` / `gemini-antigravity` / `claude-antigravity` | Gemini-family OAuth |
| `openai-custom` | Generic OpenAI-compatible upstream |
| `claude-windsurf` / `openai-windsurf` | Windsurf-related adapters |
| Droid / Warp / Orchids / AMI | Optional / experimental adapters |

> Prefer **official APIs and documented OAuth**. Experimental adapters can break and may conflict with provider terms — disable what you do not need. See [RESEARCH_USE.md](docs/public/RESEARCH_USE.md).

### Protocol bridge

AccountHub converts between client and provider shapes when needed, for example:

- Anthropic Messages ↔ OpenAI Chat / Responses  
- OpenAI Chat ↔ provider-native Responses  
- Usage normalization (including **cache read** vs uncached input) for gateway billing fields  

---

## Pricing calculator (mid-price / break-even)

Admin UI includes a **Pricing Calculator** (Codex-oriented) for research on pool cost vs sell price.  
It is an **operator worksheet**, not financial advice and not a payment product.

### Symbols

| Symbol | Meaning | Unit |
|--------|---------|------|
| **N** | Number of accounts in the active pool | count |
| **K** | Estimated monthly capacity per account | **USD of quota / account / month** |
| **U** | Utilization (how much of K is actually burned) | 0–1 |
| **P** | Sell price charged to downstream (e.g. NewAPI) | **RMB per $1 quota** |
| **C** | Fully loaded cost per account per month | **RMB / account / month** |
| **M** | Model mix factor (relative burn intensity) | ~1.0 default |
| **S** | Safety factor on break-even (buffer) | e.g. 1.3 |

Defaults in the UI (illustrative, not market quotes):

- Codex **Pro** pool sample cost ≈ **¥160 / account / month**  
- Codex **Plus** ≈ **¥9**, **Free** ≈ **¥0.3** (lab placeholders)  
- Example sell slider around **¥0.15 / $1 quota** — adjust to your real gateway pricing  

### Core formulas

```text
Monthly revenue (RMB) = N × K × U × P × M
Monthly cost    (RMB) = N × C
Monthly profit  (RMB) = N × (K × U × P × M − C)

Break-even price (with safety):
  P_min = (C × S) / (K × U × M)

Pure break-even price (S = 1):
  P_pure = C / (K × U × M)

Break-even utilization:
  U_min = (C × S) / (K × P × M)

Price safety multiple:
  safety_x = P / P_min
```

### How to read “中间价 / mid price”

In ops practice, **mid-price** is a sell point **between pure break-even and a padded break-even**, for example:

```text
P_mid ≈ (P_pure + P_min) / 2
      = C × (1 + S) / (2 × K × U × M)
```

Or, more conservatively, pick **P** so that:

```text
P ≥ P_min          # above safety break-even
safety_x ≥ 1.5~3   # UI “safety multiple” band used in the calculator
```

The calculator also scans grids of **U × P** and reverse-solves **required P** for a target monthly profit.

### Worked example (numbers are examples only)

Assume: `N=10`, `K=12266` ($/mo capacity), `U=0.5`, `C=160` RMB, `M=1`, `S=1.3`.

```text
P_pure = 160 / (12266 × 0.5 × 1) ≈ ¥0.0261 / $1
P_min  = 160 × 1.3 / (12266 × 0.5) ≈ ¥0.0339 / $1
P_mid  ≈ (0.0261 + 0.0339) / 2 ≈ ¥0.030 / $1

If you sell at P = ¥0.15 / $1:
  safety_x ≈ 0.15 / 0.0339 ≈ 4.4× above padded break-even
  monthly profit ≈ 10 × (12266 × 0.5 × 0.15 − 160) ≈ ¥7,599
```

**Always replace K/C/U with your measured pool stats** (the UI can pull live consumption when pricing APIs are configured).  
AccountHub does not set market prices; your gateway (e.g. NewAPI) owns retail pricing.

### Language note

The admin console UI is primarily **Chinese (`zh-CN`)** today (dates/number formatting and copy).  
README and legal docs are **English** for open-source clarity. Full i18n packs are welcome contributions.

---
## One-click install

> Requires Docker Compose v2. By running the installer you acknowledge the research-use notice.

**Linux / macOS**

```bash
git clone https://github.com/lmk1010/Accounthub.git
cd Accounthub
chmod +x scripts/install.sh
./scripts/install.sh
```

**Windows**

```bat
git clone https://github.com/lmk1010/Accounthub.git
cd Accounthub
scripts\install.bat
```

Then open **http://localhost:13001** (API on **http://localhost:13000**).

Full walkthrough: [docs/public/QUICKSTART.md](docs/public/QUICKSTART.md)

---
## Quick Start

### Prerequisites

- Node.js ≥ 18
- MySQL 8.0
- Docker (optional)

### Development

**Backend**

```bash
cd backend
npm install
npm run start:dev
```

**Frontend**

```bash
cd frontend
npm install
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:3000` (or your configured port)

### Configuration

Runtime configuration is stored mainly in MySQL:

- provider accounts & OAuth credentials
- pool routing / health policy
- channel defaults (models, path switches)
- system settings (ports, proxy, callback hosts)

---

## Docker

```bash
docker pull YOUR_DOCKERHUB/accounthub-backend:latest
docker pull YOUR_DOCKERHUB/accounthub-frontend:latest
```

**Backend**

```bash
docker run -d \
  --name accounthub-backend \
  --restart unless-stopped \
  -p 13000:3000 \
  -v /opt/AccountHub/configs:/app/configs \
  -v /opt/AccountHub/logs:/app/logs \
  -e NODE_ENV=production \
  YOUR_DOCKERHUB/accounthub-backend:latest
```

**Frontend**

```bash
docker run -d \
  --name accounthub-frontend \
  --restart unless-stopped \
  -p 13001:80 \
  YOUR_DOCKERHUB/accounthub-frontend:latest
```

Admin UI: `http://localhost:13001`

---

## Repository layout

```
AccountHub/
├── backend/                 # API gateway, pools, OAuth, converters
├── frontend/                # React admin console
├── scripts/install.sh       # One-click Docker installer (Linux/macOS)
├── scripts/install.bat      # One-click Docker installer (Windows)
├── docker-compose.yml       # Local MySQL + Redis + app stack
├── docs/public/             # Quick start, research use, privacy
├── NOTICE.md                # Trademarks & research notice
└── README.md
```

---

## Relationship to other software

| Name | Relationship |
|------|----------------|
| **AccountHub** | This repository — account pool + protocol gateway |
| API gateways (e.g. NewAPI) | Optional **downstream** consumers; not a fork of them |
| AI vendors (OpenAI, Anthropic, Google, xAI, …) | Upstream providers; trademarks belong to them |
| **AIClient** (any similarly named tool) | **Separate project** — no shared brand, no affiliation |

---

## Research use & disclaimer

AccountHub is distributed for **learning, research, and authorized self-hosted experiments**.

- [NOTICE.md](NOTICE.md) — trademarks, independence, experimental adapters  
- [docs/public/RESEARCH_USE.md](docs/public/RESEARCH_USE.md) — acceptable use / your responsibilities  
- [docs/public/PRIVACY.md](docs/public/PRIVACY.md) — self-host privacy guidance  
- [SECURITY.md](SECURITY.md) — vulnerability reporting  


- AccountHub is infrastructure software. **You** must comply with each provider’s Terms of Service and applicable law.
- Provider names and logos are trademarks of their respective owners; use here is for identification only.
- This project does **not** ship vendor accounts, paid quotas, or any guarantee of third-party API access.
- Experimental or unofficial provider adapters may break without notice; prefer official APIs where possible.

---

## License

MIT — see [LICENSE](LICENSE).

---

<div align="center">
  <sub>AccountHub · account pool control plane for AI providers</sub><br/>
  <sub>For research & authorized self-hosting · <a href="NOTICE.md">Notice</a> · <a href="docs/public/RESEARCH_USE.md">Research use</a> · <a href="docs/public/PRIVACY.md">Privacy</a></sub>
</div>
