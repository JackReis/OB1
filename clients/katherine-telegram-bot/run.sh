#!/usr/bin/env bash
# LaunchAgent wrapper for katherine-brain-bot (runs on Aegis).
# Injects the bot token into the env, then execs the bot. No secret is printed.
set -euo pipefail

BOT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- token injection: choose ONE backend (DEFAULT: SOPS+age; Keychain fallback) ---
# Per secrets doctrine (docs/conventions/secrets-management-bitwarden-sops-keychain.md):
# SOPS+age is preferred for headless runtime boot; macOS Keychain is the local fallback.
# The token VALUE is supplied by Jack later (see Task 5 / README "Go-live"); until then
# both lines stay commented and the bot will fail closed (main() returns 2).
#
# Option A — SOPS+age (PREFERRED, headless boot):
#   eval "$(sops exec-env ~/.secrets/katherine-bot.env 'env | grep KATHERINE_BRAIN_TELEGRAM_BOT_TOKEN')"
# Option B — macOS Keychain (fallback):
#   export KATHERINE_BRAIN_TELEGRAM_BOT_TOKEN="$(security find-generic-password -s katherine-brain-telegram-bot-token -w)"
# Option C — plaintext env file, mode 600 (ACTIVE; provisioned by Jack on Aegis).
#   File holds KATHERINE_BRAIN_TELEGRAM_BOT_TOKEN=<token>; sourced into env, never printed.
set -a
# shellcheck disable=SC1091
source ~/.secrets/katherine-brain-bot.env
set +a

# Allowlist (NOT a secret) — Katherine's numeric Telegram user id.
# Set KATHERINE_TG_USER_ID in the env file or export it before running.
# Replace the placeholder with her real numeric id before loading the agent.
export KATHERINE_TG_USER_ID="${KATHERINE_TG_USER_ID:-<KATHERINE_TG_USER_ID>}"

# Brain endpoint + recipe .env (the key is read from here at runtime, never printed):
export KB_PORT="8788"
export KB_ENV="${KB_ENV:-$(cd "$BOT_DIR/../../recipes/katherine-local-brain" && pwd)/.env}"

# UX defaults (overridable): confirm each capture; return 5 search results.
export KB_CONFIRM="1"
export KB_SEARCH_LIMIT="5"

exec /usr/bin/python3 "${BOT_DIR}/katherine_brain_bot.py"
