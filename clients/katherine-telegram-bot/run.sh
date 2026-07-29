#!/usr/bin/env bash
# LaunchAgent wrapper for katherine-brain-bot (runs on Aegis).
# Injects the bot token into the env, then execs the bot. No secret is printed.
set -euo pipefail

BOT_DIR="/Users/hermes/Projects/Sea Ranch AI/OB1/clients/katherine-telegram-bot"

# --- token injection: choose ONE backend (DEFAULT: SOPS+age; Keychain fallback) ---
# Per secrets doctrine (docs/conventions/secrets-management-bitwarden-sops-keychain.md):
# SOPS+age is preferred for headless runtime boot; macOS Keychain is the local fallback.
# The token VALUE is supplied by Jack later (see Task 5 / README "Go-live"); until then
# both lines stay commented and the bot will fail closed (main() returns 2).
#
# Option A — SOPS+age (PREFERRED, headless boot):
#   eval "$(sops exec-env /Users/hermes/.secrets/katherine-bot.env 'env | grep KATHERINE_BRAIN_TELEGRAM_BOT_TOKEN')"
# Option B — macOS Keychain (fallback):
#   export KATHERINE_BRAIN_TELEGRAM_BOT_TOKEN="$(security find-generic-password -s katherine-brain-telegram-bot-token -w)"
# Option C — plaintext env file, mode 600 (ACTIVE; provisioned by Jack on Aegis).
#   File holds KATHERINE_BRAIN_TELEGRAM_BOT_TOKEN=<token>; sourced into env, never printed.
set -a
# shellcheck disable=SC1091
source /Users/hermes/.secrets/katherine-brain-bot.env
set +a

# Allowlist (NOT a secret) — Katherine's numeric Telegram user id (supplied by Jack; Open Q 2).
# Replace the placeholder with her real numeric id before loading the agent.
# Testing allowlist = Jack's Telegram user id (swap to Katherine's id to hand over).
export KATHERINE_TG_USER_ID="7618822262"

# Brain endpoint + recipe .env (the key is read from here at runtime, never printed):
export KB_PORT="8788"
export KB_ENV="/Users/hermes/Projects/Sea Ranch AI/OB1/recipes/katherine-local-brain/.env"

# UX defaults (overridable): confirm each capture; return 5 search results.
export KB_CONFIRM="1"
export KB_SEARCH_LIMIT="5"

exec /usr/bin/python3 "${BOT_DIR}/katherine_brain_bot.py"
