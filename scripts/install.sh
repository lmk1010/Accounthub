#!/usr/bin/env bash
# AccountHub one-click installer (Docker Compose)
#
# Research / self-host lab helper only.
# Read NOTICE.md and docs/public/RESEARCH_USE.md before running.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

log() { printf '[AccountHub] %s\n' "$*"; }
die() { printf '[AccountHub] ERROR: %s\n' "$*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    # portable fallback
    head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-48
  fi
}

confirm_research_use() {
  if [[ "${ACCOUNTHUB_I_UNDERSTAND_RESEARCH_USE:-}" == "1" ]]; then
    return 0
  fi
  cat <<'EOF'

AccountHub installer — important notice
---------------------------------------
This software is provided for learning, research, and authorized self-hosted
experiments. You alone are responsible for complying with every upstream
provider's Terms of Service and with applicable law.

Do NOT use AccountHub to:
  - bypass paid plans, rate limits, or access controls you are not entitled to
  - automate account creation / bulk credential harvesting against provider rules
  - process personal data without a lawful basis and proper notices

See NOTICE.md and docs/public/RESEARCH_USE.md.
EOF
  if [[ ! -t 0 ]]; then
    die "Non-interactive shell: set ACCOUNTHUB_I_UNDERSTAND_RESEARCH_USE=1 after reading NOTICE.md"
  fi
  printf 'Type YES to continue: '
  read -r answer
  [[ "$answer" == "YES" ]] || die "Aborted."
}

main() {
  need_cmd docker
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 required (docker compose)"

  confirm_research_use

  if [[ ! -f .env ]]; then
    log "Creating .env from backend/.env.example"
    if [[ -f backend/.env.example ]]; then
      cp backend/.env.example .env
    else
      cat > .env <<'EOF'
USE_DATABASE=true
DB_DATABASE=accounthub
DB_USER=accounthub
DB_PASSWORD=change-me
MYSQL_ROOT_PASSWORD=change-me-root
REDIS_KEY_PREFIX=accounthub:
REQUIRED_API_KEY=change-me-admin-or-gateway-key
HOST=0.0.0.0
SERVER_PORT=3000
OAUTH_CALLBACK_HOST=localhost
OAUTH_CALLBACK_SCHEME=http
BACKEND_PORT=13000
FRONTEND_PORT=13001
EOF
    fi
    # strengthen defaults for first install
    local api_key db_pass root_pass
    api_key="$(generate_secret)"
    db_pass="$(generate_secret)"
    root_pass="$(generate_secret)"
    if grep -q '^REQUIRED_API_KEY=' .env; then
      sed -i.bak "s|^REQUIRED_API_KEY=.*|REQUIRED_API_KEY=${api_key}|" .env
    else
      echo "REQUIRED_API_KEY=${api_key}" >> .env
    fi
    if grep -q '^DB_PASSWORD=' .env; then
      sed -i.bak "s|^DB_PASSWORD=.*|DB_PASSWORD=${db_pass}|" .env
    else
      echo "DB_PASSWORD=${db_pass}" >> .env
    fi
    if grep -q '^MYSQL_ROOT_PASSWORD=' .env; then
      sed -i.bak "s|^MYSQL_ROOT_PASSWORD=.*|MYSQL_ROOT_PASSWORD=${root_pass}|" .env
    else
      echo "MYSQL_ROOT_PASSWORD=${root_pass}" >> .env
    fi
    rm -f .env.bak
    log "Generated REQUIRED_API_KEY / DB passwords into .env (keep this file private)"
  else
    log "Using existing .env"
  fi

  log "Building and starting containers..."
  docker compose up -d --build

  log "Waiting for backend health..."
  local ok=0
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${BACKEND_PORT:-13000}/api/system/health" >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 3
  done

  if [[ "$ok" -ne 1 ]]; then
    log "Backend health not ready yet. Check: docker compose logs -f backend"
  else
    log "Backend is healthy."
  fi

  cat <<EOF

AccountHub is starting.
  Admin UI : http://localhost:${FRONTEND_PORT:-13001}
  API      : http://localhost:${BACKEND_PORT:-13000}

Next steps:
  1) Open the admin UI and complete first-time admin password setup if prompted
  2) Put REQUIRED_API_KEY from .env into your gateway / client configuration
  3) Add only credentials you are authorized to use
  4) Read docs/public/QUICKSTART.md and docs/public/RESEARCH_USE.md

Stop stack:
  docker compose down
EOF
}

main "$@"
