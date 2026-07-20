# AccountHub Quick Start

> For learning, research, and **authorized** self-hosting only.  
> Read [NOTICE.md](../../NOTICE.md) and [RESEARCH_USE.md](./RESEARCH_USE.md) first.

## Option A — One-click (Docker Compose)

### Requirements

- Docker Engine + Compose v2  
- ~2 GB RAM free for MySQL + backend  
- Ports free: `13001` (UI), `13000` (API) by default  

### Linux / macOS

```bash
git clone https://github.com/lmk1010/Accounthub.git
cd Accounthub
chmod +x scripts/install.sh
./scripts/install.sh
```

The script will:

1. Ask you to confirm research-use notice (`YES`)  
2. Create a local `.env` with random secrets if missing  
3. `docker compose up -d --build`  
4. Print Admin UI / API URLs  

### Windows

```bat
git clone https://github.com/lmk1010/Accounthub.git
cd Accounthub
scripts\install.bat
```

### After install

| Service | URL |
|---------|-----|
| Admin UI | http://localhost:13001 |
| API | http://localhost:13000 |

1. Open Admin UI → complete first-time admin password if prompted  
2. Copy `REQUIRED_API_KEY` from `.env` into your API client / gateway  
3. Add **only** credentials you are allowed to use  
4. Prefer official provider APIs / documented OAuth  

### Stop / reset

```bash
docker compose down          # keep volumes
docker compose down -v       # wipe MySQL/Redis data
```

---

## Option B — Manual development

```bash
# MySQL 8 + optional Redis running locally
cd backend
cp .env.example .env.development
# edit DB_* and REQUIRED_API_KEY
npm install
# import schema
mysql -u ... -p accounthub < sql/all_tables.sql
npm run start:dev

cd ../frontend
cp .env.example .env.development
npm install
npm run dev
```

---

## First configuration checklist

- [ ] Changed all default passwords / API keys  
- [ ] Admin UI not exposed to the public internet without auth + TLS  
- [ ] Read [PRIVACY.md](./PRIVACY.md) if you will store personal data  
- [ ] Disabled experimental providers you do not need  
- [ ] Confirmed OAuth callback host/ports match your deployment  

### Optional Google OAuth public clients

For Gemini CLI / Antigravity OAuth flows, set in `.env`:

```bash
GEMINI_OAUTH_CLIENT_ID=...
GEMINI_OAUTH_CLIENT_SECRET=...
ANTIGRAVITY_OAUTH_CLIENT_ID=...
ANTIGRAVITY_OAUTH_CLIENT_SECRET=...
```

Use credentials from **your** Google Cloud project or an official client you are permitted to use.  
**Do not commit secrets.**

---

## Connecting a gateway (e.g. NewAPI)

AccountHub is typically **upstream** of a user-facing gateway:

```text
Users → NewAPI / your gateway → AccountHub → providers
```

- Point the gateway’s channel base URL at AccountHub’s OpenAI- or Anthropic-compatible routes  
- Use `REQUIRED_API_KEY` as the upstream key  
- Keep user billing/auth in the gateway; keep account pools in AccountHub  

---

## Troubleshooting

| Symptom | Check |
|---------|--------|
| UI up, API 502 | `docker compose logs backend` |
| DB connection errors | MySQL healthy? `DB_PASSWORD` match? |
| OAuth callback fails | `OAUTH_CALLBACK_HOST` / ports `8085`/`8086` reachable? |
| Empty provider list | Add credentials in Admin → Providers |

---

## Uninstall

```bash
docker compose down -v
rm -f .env
```

Remove the git checkout when finished.
