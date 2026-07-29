#!/usr/bin/env python3
"""Katherine Telegram Brain Bot.

A single-file, stdlib-only Telegram <-> OB1 bridge. Long-polls a dedicated
bot, filters every update against a one-person allowlist (Katherine's Telegram
user id), and maps:

    plain message            -> capture_thought   (content/task_id/source)
    "/recall <q>" or "? <q>" -> search_thoughts   (query/limit)
    "/stats"                 -> thought_stats
    "/start" / "/help"       -> help text

Talks to Katherine's brain over loopback (127.0.0.1:8788) with her
BRAIN_ACCESS_KEY, read at runtime from the recipe .env (never logged).

Runs on Aegis as a LaunchAgent. Secrets are injected via env by run.sh;
this module never contains a token or key.

DEFAULTS (all overridable via env; see run.sh / README):
    KB_PORT=8788              Katherine's brain (loopback on Aegis)
    KB_CONFIRM=1             reply "saved ✓ (...)" on each capture
    KB_SEARCH_LIMIT=5        results returned per /recall
    KB_TASK_ID=katherine/telegram
    KB_SOURCE=katherine-telegram

REQUIRED env (fail closed if unset — see main()):
    KATHERINE_BRAIN_TELEGRAM_BOT_TOKEN   BotFather token (secret backend)
    KATHERINE_TG_USER_ID                 Katherine's numeric Telegram user id
"""
from __future__ import annotations

import http.client
import json
import logging
import os
import sys
import time
import urllib.parse

# --- config (all overridable via env; no secrets hard-coded) ---
BRAIN_HOST = os.environ.get("KB_HOST", "127.0.0.1")
BRAIN_PORT = int(os.environ.get("KB_PORT", "8788"))
BRAIN_ENV_PATH = os.environ.get(
    "KB_ENV",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "recipes", "katherine-local-brain", ".env"),
)
MCP_PATH = "/functions/v1/open-brain-mcp"
CAPTURE_TASK_ID = os.environ.get("KB_TASK_ID", "katherine/telegram")
CAPTURE_SOURCE = os.environ.get("KB_SOURCE", "katherine-telegram")
SEARCH_LIMIT = int(os.environ.get("KB_SEARCH_LIMIT", "5"))
CONFIRM_CAPTURES = os.environ.get("KB_CONFIRM", "1") == "1"  # reply "saved" (Open Q 4)
STATE_DIR = os.environ.get("KB_STATE_DIR", os.path.expanduser("~/.katherine-brain-bot"))
POLL_TIMEOUT = int(os.environ.get("KB_POLL_TIMEOUT", "50"))  # long-poll seconds

HELP_TEXT = (
    "🧠 Katherine's brain\n"
    "• Send any message → I save it as a thought.\n"
    "• /recall <words> (or start with ?) → I search your thoughts.\n"
    "• /stats → how many thoughts you have.\n"
)

log = logging.getLogger("katherine-brain-bot")


# --- allowlist: the security boundary. Fail CLOSED. ---
def is_allowed(update: dict, allowed_user_id) -> bool:
    """True only if this update carries a message from the allowlisted user id.
    allowed_user_id None/empty => nobody allowed (fail closed)."""
    if allowed_user_id in (None, "", 0):
        return False
    msg = update.get("message") or update.get("edited_message")
    if not msg:
        return False
    sender = (msg.get("from") or {}).get("id")
    try:
        return int(sender) == int(allowed_user_id)
    except (TypeError, ValueError):
        return False


# --- routing: pure text -> (action, payload) ---
def route_message(text: str):
    """Map raw message text to (action, payload).
    actions: capture | recall | stats | help."""
    t = (text or "").strip()
    if not t:
        return "help", {}
    low = t.lower()
    if low in ("/start", "/help"):
        return "help", {}
    if low == "/stats" or low.startswith("/stats"):
        return "stats", {}
    if low.startswith("/recall"):
        q = t[len("/recall"):].strip()
        return ("recall", {"query": q}) if q else ("help", {})
    if t.startswith("?"):
        q = t[1:].strip()
        return ("recall", {"query": q}) if q else ("help", {})
    # anything else is a thought to capture
    return "capture", {"content": t}


# --- brain (loopback MCP) ---
def _read_brain_key(env_path: str) -> str:
    with open(env_path) as fh:
        for line in fh:
            if line.startswith("BRAIN_ACCESS_KEY="):
                return line.split("=", 1)[1].strip()
    raise SystemExit(f"BRAIN_ACCESS_KEY not found in {env_path}")


def _brain_call(name: str, arguments: dict, key: str, timeout: int = 30):
    payload = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }).encode()
    c = http.client.HTTPConnection(BRAIN_HOST, BRAIN_PORT, timeout=timeout)
    c.request("POST", MCP_PATH, body=payload,
              headers={"Content-Type": "application/json", "x-brain-key": key})
    r = c.getresponse()
    body = r.read().decode().strip()
    c.close()
    if not (body.startswith("{") or body.startswith("[")):
        for ln in body.split("\n"):
            if ln.strip().startswith("data:"):
                body = ln.strip()[5:].strip()
                break
    return r.status, json.loads(body)


def _result_text(res: dict) -> str:
    try:
        return res["result"]["content"][0]["text"]
    except (KeyError, IndexError, TypeError):
        return json.dumps(res)[:500]


# --- telegram (long-poll; token only via env, never logged) ---
def _tg(method: str, params: dict, token: str, timeout: int = 60):
    body = urllib.parse.urlencode(params).encode()
    c = http.client.HTTPSConnection("api.telegram.org", 443, timeout=timeout)
    c.request("POST", f"/bot{token}/{method}", body=body,
              headers={"Content-Type": "application/x-www-form-urlencoded"})
    r = c.getresponse()
    data = json.loads(r.read().decode())
    c.close()
    return data


def _send(chat_id, text, token):
    try:
        _tg("sendMessage", {"chat_id": chat_id, "text": text}, token, timeout=20)
    except Exception as exc:  # never crash the loop on a send failure
        log.warning("sendMessage failed: %s", type(exc).__name__)


def _load_offset() -> int:
    try:
        with open(os.path.join(STATE_DIR, "state.json")) as fh:
            return int(json.load(fh).get("offset", 0))
    except (FileNotFoundError, ValueError, json.JSONDecodeError):
        return 0


def _save_offset(offset: int) -> None:
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = os.path.join(STATE_DIR, "state.json.tmp")
    with open(tmp, "w") as fh:
        json.dump({"offset": offset}, fh)
    os.replace(tmp, os.path.join(STATE_DIR, "state.json"))


def handle_update(update: dict, token: str, allowed_user_id, brain_key: str) -> None:
    if not is_allowed(update, allowed_user_id):
        sender = ((update.get("message") or {}).get("from") or {}).get("id")
        log.info("ignored non-allowlisted sender id=%s", sender)
        return
    msg = update.get("message") or update.get("edited_message")
    chat_id = msg["chat"]["id"]
    action, payload = route_message(msg.get("text", ""))
    if action == "help":
        _send(chat_id, HELP_TEXT, token)
        return
    if action == "capture":
        st, res = _brain_call("capture_thought",
                              {"content": payload["content"],
                               "task_id": CAPTURE_TASK_ID, "source": CAPTURE_SOURCE},
                              brain_key)
        txt = _result_text(res)
        log.info("capture status=%s -> %s", st, txt)
        if CONFIRM_CAPTURES:
            _send(chat_id, f"saved ✓ ({txt})" if st == 200 else "⚠️ save failed", token)
        return
    if action == "recall":
        st, res = _brain_call("search_thoughts",
                              {"query": payload["query"], "limit": SEARCH_LIMIT}, brain_key)
        _send(chat_id, _result_text(res) if st == 200 else "⚠️ search failed", token)
        return
    if action == "stats":
        st, res = _brain_call("thought_stats", {}, brain_key)
        _send(chat_id, _result_text(res) if st == 200 else "⚠️ stats failed", token)
        return


def main() -> int:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    token = os.environ.get("KATHERINE_BRAIN_TELEGRAM_BOT_TOKEN")
    if not token:
        log.error("KATHERINE_BRAIN_TELEGRAM_BOT_TOKEN not set — refusing to start")
        return 2
    allowed_raw = os.environ.get("KATHERINE_TG_USER_ID")  # numeric id; fail closed if unset
    allowed_user_id = int(allowed_raw) if (allowed_raw and allowed_raw.isdigit()) else None
    if allowed_user_id is None:
        log.error("KATHERINE_TG_USER_ID not set/numeric — refusing to start (fail closed)")
        return 2
    brain_key = _read_brain_key(BRAIN_ENV_PATH)
    offset = _load_offset()
    log.info("katherine-brain-bot up: brain=%s:%s allow=%s offset=%s",
             BRAIN_HOST, BRAIN_PORT, allowed_user_id, offset)
    while True:
        try:
            resp = _tg("getUpdates", {"offset": offset, "timeout": POLL_TIMEOUT},
                       token, timeout=POLL_TIMEOUT + 15)
            for update in resp.get("result", []):
                offset = update["update_id"] + 1
                try:
                    handle_update(update, token, allowed_user_id, brain_key)
                except Exception as exc:
                    log.exception("handle_update error: %s", type(exc).__name__)
                _save_offset(offset)
        except Exception as exc:
            log.warning("poll error: %s — backing off 5s", type(exc).__name__)
            time.sleep(5)


if __name__ == "__main__":
    sys.exit(main())
