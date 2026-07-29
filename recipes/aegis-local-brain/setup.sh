#!/usr/bin/env bash
set -euo pipefail

RECIPE_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${RECIPE_DIR}/.env"

log() { printf '  ==> %s\n' "$*"; }
die() { printf '  xxx %s\n' "$*" >&2; exit 1; }

check_prereqs() {
  command -v docker >/dev/null || die "docker not found"
  command -v openssl >/dev/null || die "openssl not found"
  command -v python3 >/dev/null || die "python3 not found"
  docker compose version >/dev/null || die "docker compose not available"
}

gen_secret_hex() {
  openssl rand -hex "${1:-32}"
}

gen_service_role_jwt() {
  local jwt_secret="$1"
  python3 - "$jwt_secret" <<'PY'
import base64
import hashlib
import hmac
import json
import sys
import time

secret = sys.argv[1].encode()

def b64u(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

def sign(payload):
    header = {"alg": "HS256", "typ": "JWT"}
    encoded_header = b64u(json.dumps(header, separators=(",", ":")).encode())
    encoded_payload = b64u(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(secret, f"{encoded_header}.{encoded_payload}".encode(), hashlib.sha256).digest()
    return f"{encoded_header}.{encoded_payload}.{b64u(sig)}"

now = int(time.time())
exp = now + 10 * 365 * 24 * 3600
print(sign({"role": "service_role", "iat": now, "exp": exp}))
PY
}

write_env() {
  if [ -f "$ENV_FILE" ]; then
    log ".env already exists; preserving local secrets"
    return
  fi

  local postgres_password postgrest_db_password jwt_secret service_role_key brain_access_key
  postgres_password="$(gen_secret_hex 24)"
  postgrest_db_password="$(gen_secret_hex 24)"
  jwt_secret="$(gen_secret_hex 32)"
  service_role_key="$(gen_service_role_jwt "$jwt_secret")"
  brain_access_key="$(gen_secret_hex 32)"

  cat > "$ENV_FILE" <<EOF
POSTGRES_DB=openbrain
POSTGRES_USER=openbrain_admin
POSTGRES_PASSWORD=${postgres_password}
POSTGREST_DB_PASSWORD=${postgrest_db_password}
JWT_SECRET=${jwt_secret}
SERVICE_ROLE_KEY=${service_role_key}
BRAIN_ACCESS_KEY=${brain_access_key}

BRAIN_BIND_ADDR=127.0.0.1
BRAIN_API_PORT=8787

OLLAMA_URL=http://host.docker.internal:11434
OLLAMA_EMBED_PATH=/api/embed
EMBED_MODEL=mxbai-embed-large
EMBED_DIM=1024
EOF
  chmod 600 "$ENV_FILE"
  log "wrote local secrets to $ENV_FILE"
}

print_next_steps() {
  local port bind
  port="$(grep -E '^BRAIN_API_PORT=' "$ENV_FILE" | cut -d= -f2- || true)"
  bind="$(grep -E '^BRAIN_BIND_ADDR=' "$ENV_FILE" | cut -d= -f2- || true)"
  port="${port:-8787}"
  bind="${bind:-127.0.0.1}"

  cat <<EOF

  Aegis local brain setup is ready.

  Secrets are in:
    $ENV_FILE

  Next:
    cd "$RECIPE_DIR"
    docker compose up -d
    curl -fsS "http://${bind}:${port}/health"

  For local clients on Aegis:
    export BRAIN_URL="http://${bind}:${port}"
    export BRAIN_ACCESS_KEY=<read from $ENV_FILE on Aegis>

  This setup does not print secret values.

EOF
}

main() {
  check_prereqs
  write_env
  print_next_steps
}

main "$@"
