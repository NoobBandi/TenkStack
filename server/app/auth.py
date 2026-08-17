"""Session and API-key authentication.

Two ways in, for two kinds of caller:

- browsers get an HttpOnly session cookie from POST /api/auth/login;
- everything else (other apps, scripts, family members' clients) sends an API
  key, which is what makes the keys minted on the Users page worth anything.

Sessions are HMAC-signed tokens rather than server-side state, so a backend
restart does not log everybody out. The signing secret is persisted for the same
reason -- generating it at import time would silently invalidate every session
on every restart, which reads as random logouts.
"""

from __future__ import annotations

import base64
import hmac
import json
import logging
import os
import time
from hashlib import sha256

from fastapi import HTTPException, Request

from . import users
from . import paths

logger = logging.getLogger(__name__)

SECRET_PATH = paths.SESSION_KEY
COOKIE_NAME = "ai_console_session"
SESSION_TTL = 30 * 24 * 3600  # 30 days; this is a household, not a bank.

# Everything else under /api requires a caller. Login must be open or nobody
# could ever authenticate, and health is what a proxy probes before any user
# exists.
PUBLIC_PATHS = {"/api/auth/login", "/api/health"}


def _secret() -> bytes:
    if SECRET_PATH.exists():
        return SECRET_PATH.read_bytes()
    SECRET_PATH.parent.mkdir(parents=True, exist_ok=True)
    secret = os.urandom(32)
    SECRET_PATH.write_bytes(secret)
    SECRET_PATH.chmod(0o600)
    logger.info("generated a new session signing key at %s", SECRET_PATH)
    return secret


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def issue_session(user: dict) -> str:
    payload = json.dumps(
        {"uid": user["id"], "username": user["username"],
         "role": user["role"], "exp": int(time.time()) + SESSION_TTL},
        separators=(",", ":"),
    ).encode()
    signature = hmac.new(_secret(), payload, sha256).digest()
    return f"{_b64(payload)}.{_b64(signature)}"


def read_session(token: str | None) -> dict | None:
    if not token or "." not in token:
        return None
    encoded_payload, _, encoded_signature = token.partition(".")
    try:
        payload = _unb64(encoded_payload)
        signature = _unb64(encoded_signature)
    except Exception:
        return None

    expected = hmac.new(_secret(), payload, sha256).digest()
    if not hmac.compare_digest(expected, signature):
        return None

    try:
        claims = json.loads(payload)
    except json.JSONDecodeError:
        return None

    if claims.get("exp", 0) < time.time():
        return None
    return claims


def identify(request: Request) -> dict | None:
    """Resolve the caller from a session cookie or an API key."""
    claims = read_session(request.cookies.get(COOKIE_NAME))
    if claims:
        return {"user_id": claims["uid"], "username": claims["username"],
                "role": claims["role"], "via": "session"}

    header = request.headers.get("authorization", "")
    key = header[7:].strip() if header.lower().startswith("bearer ") else None
    key = key or request.headers.get("x-api-key")
    if key:
        identity = users.verify_api_key(key)
        if identity:
            return {**identity, "via": "api-key"}
    return None


def enforcement_enabled() -> bool:
    """Auth turns itself on once an account exists.

    Requiring login before any account is created would lock the owner out of
    their own console with no way back in, so the first run is deliberately
    open. It closes the moment the first user is added.
    """
    try:
        return bool(users.list_users())
    except Exception:
        # A broken user store must fail closed, not open.
        logger.exception("could not read the user store; failing closed")
        return True


def require_owner(request: Request) -> dict | None:
    """A logged-in administrator, in a browser, and nothing else.

    The middleware gates `/api` and `/v1` identically: any identity passes any
    route. That is right for everything that reads GPU telemetry or starts a
    model, and wrong for the routes that reach the filesystem, because the two
    kinds of identity are not interchangeable.

    An API key is minted to be pasted into somebody's chat client. It is meant
    for `/v1/chat/completions`, it is long-lived, and it travels. A key that
    also opens a file browser makes every client on the household network able
    to read this machine's home directory -- which is not what anyone thought
    they were handing out. So the filesystem routes take a session cookie only.

    The `role` claim has been carried in every token since accounts existed and
    read by nothing. This is the first thing to enforce it.

    Returns None while enforcement is off, matching the rest of the app: before
    the first account exists there is nobody to be an administrator.
    """
    if not enforcement_enabled():
        return None

    identity = getattr(request.state, "identity", None) or identify(request)
    if identity is None:
        raise HTTPException(status_code=401, detail="請先登入")
    if identity.get("via") != "session":
        raise HTTPException(
            status_code=403,
            detail="這個功能只接受登入後的瀏覽器工作階段，不接受 API 金鑰",
        )
    if identity.get("role") != "admin":
        raise HTTPException(status_code=403, detail="這個功能限管理員使用")
    return identity
