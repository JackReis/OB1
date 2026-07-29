#!/usr/bin/env python3
"""family_memory_router.py — the PRIVACY WALL core for the Family Hermes assistant.

Mediates ALL memory recall/capture for a single Hermes bot serving BOTH Jack and
Katherine, keyed on the *gateway-verified* Telegram sender id. The model has NO
brain tool — it can never choose a brain. Talking to X reads/writes {X-private +
shared} ONLY; never the other person's private brain. Unknown sender -> fail
closed (shared-only for recall, drop for private capture).

Wired as two Hermes command hooks (see config.yaml):
  pre_llm_call  -> `--event user-prompt-submit`  (RECALL; prints {"context": ...})
  post_llm_call -> `--event stop`                (CAPTURE; side-effect only)

Identity mechanism (verified against hermes-agent source, 2026-07-01):
  * pre_llm_call passes `sender_id=agent._user_id` (gateway-verified) -> arrives in
    the hook stdin as extra.sender_id. RECALL resolves scope directly from it and
    persists {session_id: scope} to a mode-600 state file.
  * post_llm_call does NOT pass sender_id (only session_id). CAPTURE looks scope up
    in that state file (pre_llm_call always fires before post_llm_call in the same
    turn, same session_id). Missing -> fail closed.

Env (injected via the profile .env; NO secrets hardcoded):
  FAMILY_JACK_ID, FAMILY_KATH_ID            -- Telegram numeric ids (strings)
  OB1_JACK_HOST/PORT/KEY                     -- Jack private brain (:8787)
  OB1_KATH_HOST/PORT/KEY                     -- Katherine private brain (:8788)
  OB1_SHARED_HOST/PORT/KEY                   -- shared/family brain (:8790)
  FAMILY_ROUTER_STATE                        -- session_scope.json path (optional)
  FAMILY_ROUTER_LOG                          -- log path (optional; names/UUIDs only)

Stdlib only. http.client with host/port as separate args (no http:// literal).
Fail-OPEN on any error (never block a turn); logs tool names/uuids only, never keys.
"""
from __future__ import annotations

import http.client
import json
import os
import sys
import time
import uuid

MCP_PATH = "/functions/v1/open-brain-mcp"

# Logical scope keys used by the pure wall functions (no ports/keys here).
JACK = "jack"
KATH = "katherine"
SHARED = "shared"

# Private-by-default (D5). Promote a capture to the shared brain only on an
# explicit sharing cue. Conservative on purpose: accidental captures must never
# land in the shared plane.
_SHARE_CUES = (
    "our ", "our.", "ours", "both of us", "both", "family", "shared",
    "share this", "add to our", "for us", "we need", "we should", "let's",
    "trip", "household", "the board", "kanban", "our notes", "our plans",
)


# ---------------------------------------------------------------------------
# PURE wall logic (no network, no env) — this is what the unit tests pin down.
# ---------------------------------------------------------------------------
def scope_from_sender(sender_id, jack_id, kath_id):
    """Map a gateway-verified sender id to a memory scope. Unknown -> None."""
    if sender_id is None:
        return None
    s = str(sender_id).strip()
    if not s:
        return None
    if jack_id and s == str(jack_id).strip():
        return JACK
    if kath_id and s == str(kath_id).strip():
        return KATH
    return None


def recall_targets(scope):
    """Brains to READ for a turn. WALL: a person's private brain is NEVER
    readable for the other person. Unknown scope -> shared only (fail closed)."""
    if scope == JACK:
        return {JACK, SHARED}
    if scope == KATH:
        return {KATH, SHARED}
    return {SHARED}


def capture_targets(scope, promote_shared):
    """Brains to WRITE for a turn. Private-by-default; promote to shared only on
    an explicit cue. WALL: NEVER writes to the other person's private brain.
    Unknown scope -> shared only (private facts from an unknown sender are dropped
    from any private plane)."""
    if scope == JACK:
        return {JACK, SHARED} if promote_shared else {JACK}
    if scope == KATH:
        return {KATH, SHARED} if promote_shared else {KATH}
    return {SHARED}


def classify_promote(text):
    """Private-by-default -> True only when an explicit sharing cue is present."""
    if not text:
        return False
    low = text.lower()
    return any(cue in low for cue in _SHARE_CUES)


def origin_label(scope_key):
    return "(shared/family)" if scope_key == SHARED else "(your note)"


# ---------------------------------------------------------------------------
# Runtime config (env -> {scope_key: (host, port, key)}); resolved lazily.
# ---------------------------------------------------------------------------
def _brain(prefix, default_port):
    host = os.environ.get(f"OB1_{prefix}_HOST", "127.0.0.1")
    port = int(os.environ.get(f"OB1_{prefix}_PORT", str(default_port)))
    key = os.environ.get(f"OB1_{prefix}_KEY", "")
    return host, port, key


def brains():
    return {
        JACK: _brain("JACK", 8787),
        KATH: _brain("KATH", 8788),
        SHARED: _brain("SHARED", 8790),
    }


def id_map():
    return os.environ.get("FAMILY_JACK_ID", ""), os.environ.get("FAMILY_KATH_ID", "")


def state_path():
    return os.environ.get(
        "FAMILY_ROUTER_STATE",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "state", "session_scope.json"),
    )


def log_path():
    return os.environ.get(
        "FAMILY_ROUTER_LOG",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "state", "router.log"),
    )


def _log(msg):
    try:
        p = log_path()
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "a") as fh:
            fh.write(f"{int(time.time())} {msg}\n")
    except Exception:
        pass  # logging must never break a turn


# ---------------------------------------------------------------------------
# session_id <-> scope state (mode 600). Written by RECALL, read by CAPTURE.
# ---------------------------------------------------------------------------
def load_state(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return {}


def save_scope(path, session_id, scope):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        st = load_state(path)
        # keep it small: cap at ~200 sessions
        if len(st) > 200:
            st = dict(list(st.items())[-100:])
        st[str(session_id)] = scope
        tmp = f"{path}.tmp.{uuid.uuid4().hex[:8]}"
        with open(tmp, "w") as fh:
            json.dump(st, fh)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except Exception as exc:
        _log(f"WARN save_scope failed: {type(exc).__name__}")


def scope_for_session(path, session_id):
    return load_state(path).get(str(session_id))


# ---------------------------------------------------------------------------
# Network (http.client; host/port separate args — no http:// literal).
# ---------------------------------------------------------------------------
def _mcp(host, port, key, name, arguments, timeout=15):
    payload = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }).encode()
    c = http.client.HTTPConnection(host, port, timeout=timeout)
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


def _text_of(res):
    try:
        return res.get("result", {}).get("content", [{}])[0].get("text", "")
    except Exception:
        return ""


import re as _re

_DATA_URI = _re.compile(r"!?\[[^\]]*\]\(data:[^)]*\)|data:[^\s)]{40,}")


def _trim(txt, limit=900):
    """Keep injected recall lean: strip base64/data-URI blobs and cap length so a
    single note can't flood the turn context (and tokens)."""
    txt = _DATA_URI.sub("[omitted embedded media]", txt or "")
    txt = _re.sub(r"[A-Za-z0-9+/]{200,}={0,2}", "[omitted blob]", txt)  # bare base64
    if len(txt) > limit:
        txt = txt[:limit].rstrip() + " …"
    return txt


# ---------------------------------------------------------------------------
# Event handlers
# ---------------------------------------------------------------------------
def handle_recall(data):
    """pre_llm_call: read speaker-private + shared, inject as {"context": ...}."""
    session_id = data.get("session_id") or ""
    extra = data.get("extra") or {}
    sender_id = extra.get("sender_id") or data.get("sender_id")
    user_message = extra.get("user_message") or ""

    jack_id, kath_id = id_map()
    scope = scope_from_sender(sender_id, jack_id, kath_id)
    save_scope(state_path(), session_id, scope)
    _log(f"RECALL session={session_id} scope={scope} targets={sorted(recall_targets(scope))}")

    if not user_message.strip():
        return None

    cfg = brains()
    snippets = []
    for key_name in sorted(recall_targets(scope)):
        host, port, brain_key = cfg[key_name]
        if not brain_key:
            continue
        try:
            st, res = _mcp(host, port, brain_key, "search_thoughts",
                           {"query": user_message, "limit": 4})
            if st != 200:
                continue
            txt = _trim(_text_of(res).strip())
            if txt and "Found 0" not in txt and "No thoughts found" not in txt:
                snippets.append(f"{origin_label(key_name)}\n{txt}")
        except Exception as exc:
            _log(f"WARN recall {key_name} failed: {type(exc).__name__}")
    if not snippets:
        return None
    header = ("Relevant things you remember (private notes are only for the person "
              "you're talking with; never share one person's private notes with the other):")
    return {"context": header + "\n\n" + "\n\n".join(snippets)}


def handle_capture(data):
    """post_llm_call: private-by-default capture to speaker-private (+shared on cue)."""
    session_id = data.get("session_id") or ""
    extra = data.get("extra") or {}
    user_message = extra.get("user_message") or ""
    if not user_message.strip():
        return None

    scope = scope_for_session(state_path(), session_id)  # set by RECALL this turn
    promote = classify_promote(user_message)
    targets = capture_targets(scope, promote)
    _log(f"CAPTURE session={session_id} scope={scope} promote={promote} targets={sorted(targets)}")

    # Fail closed: unknown scope -> never write to a private plane. Drop unless a
    # shared cue is present (avoid polluting the shared brain with stray turns).
    if scope is None and not promote:
        _log("CAPTURE dropped: unknown scope, no share cue")
        return None

    cfg = brains()
    tid = f"family/{scope or 'unknown'}"
    for key_name in sorted(targets):
        host, port, brain_key = cfg[key_name]
        if not brain_key:
            continue
        try:
            st, res = _mcp(host, port, brain_key, "capture_thought",
                           {"content": user_message, "task_id": tid, "source": "family-assistant"})
            _log(f"CAPTURE {key_name} status={st} -> {_text_of(res)[:60]}")
        except Exception as exc:
            _log(f"WARN capture {key_name} failed: {type(exc).__name__}")
    return None


def main(argv):
    event = ""
    if "--event" in argv:
        i = argv.index("--event")
        if i + 1 < len(argv):
            event = argv[i + 1]
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
    except Exception as exc:
        _log(f"WARN bad stdin: {type(exc).__name__}")
        return 0  # fail open

    try:
        if event in ("user-prompt-submit", "pre_llm_call", "recall"):
            out = handle_recall(data)
        elif event in ("stop", "post_llm_call", "capture"):
            out = handle_capture(data)
        else:
            out = None
    except Exception as exc:
        _log(f"WARN handler {event} failed: {type(exc).__name__}")
        out = None  # fail open

    if out is not None:
        sys.stdout.write(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
