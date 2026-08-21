"""Users and API keys, in SQLite.

Scope is a household, not a tenant system: a handful of accounts, two roles, and
API keys for anything that talks to the OpenAI endpoint without a browser.

IMPORTANT: this module stores and verifies credentials but nothing enforces them
yet -- no route requires a session. Enforcement is deliberately deferred to the
reverse proxy step, so that the console is never in a state where it *looks*
protected while every endpoint is open. Treat the box as unauthenticated until
that lands.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets
import sqlite3
import time
from . import db, paths

logger = logging.getLogger(__name__)

DB_PATH = paths.DB_PATH
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2**14, 8, 1
KEY_PREFIX = "sk-console-"


def _connect() -> sqlite3.Connection:
    return db.connect()


def init() -> None:
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL DEFAULT '',
                password_hash TEXT NOT NULL,
                salt TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'member',
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS api_keys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                prefix TEXT NOT NULL,
                key_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                last_used_at INTEGER
            );
            """
        )


def _hash_password(password: str, salt: bytes) -> str:
    derived = hashlib.scrypt(
        password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32
    )
    return derived.hex()


def create_user(username: str, password: str, display_name: str = "", role: str = "member") -> dict:
    salt = os.urandom(16)
    now = int(time.time())
    with _connect() as conn:
        cursor = conn.execute(
            "INSERT INTO users (username, display_name, password_hash, salt, role, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (username, display_name or username, _hash_password(password, salt), salt.hex(), role, now),
        )
        user_id = cursor.lastrowid
    logger.info("created user %s (role=%s)", username, role)
    return {"id": user_id, "username": username, "display_name": display_name or username,
            "role": role, "created_at": now}


def verify_password(username: str, password: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if row is None:
        # Still derive a hash so a missing user and a wrong password take the
        # same time; otherwise the response time enumerates valid usernames.
        _hash_password(password, os.urandom(16))
        return None
    expected = _hash_password(password, bytes.fromhex(row["salt"]))
    if not hmac.compare_digest(expected, row["password_hash"]):
        return None
    return {"id": row["id"], "username": row["username"],
            "display_name": row["display_name"], "role": row["role"]}


def list_users() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT u.id, u.username, u.display_name, u.role, u.created_at,"
            " (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = u.id) AS key_count"
            " FROM users u ORDER BY u.id"
        ).fetchall()
    return [dict(r) for r in rows]


def delete_user(user_id: int) -> bool:
    with _connect() as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        cursor = conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        return cursor.rowcount > 0


def set_password(user_id: int, password: str) -> bool:
    salt = os.urandom(16)
    with _connect() as conn:
        cursor = conn.execute(
            "UPDATE users SET password_hash = ?, salt = ? WHERE id = ?",
            (_hash_password(password, salt), salt.hex(), user_id),
        )
        return cursor.rowcount > 0


def create_api_key(user_id: int, name: str) -> dict:
    """Mint a key. The full value is returned exactly once and never stored."""
    secret = KEY_PREFIX + secrets.token_urlsafe(32)
    prefix = secret[: len(KEY_PREFIX) + 6]
    key_hash = hashlib.sha256(secret.encode()).hexdigest()
    now = int(time.time())
    with _connect() as conn:
        cursor = conn.execute(
            "INSERT INTO api_keys (user_id, name, prefix, key_hash, created_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (user_id, name, prefix, key_hash, now),
        )
        key_id = cursor.lastrowid
    return {"id": key_id, "name": name, "prefix": prefix, "created_at": now, "secret": secret}


def list_api_keys(user_id: int | None = None) -> list[dict]:
    sql = ("SELECT k.id, k.user_id, k.name, k.prefix, k.created_at, k.last_used_at,"
           " u.username FROM api_keys k JOIN users u ON u.id = k.user_id")
    params: tuple = ()
    if user_id is not None:
        sql += " WHERE k.user_id = ?"
        params = (user_id,)
    with _connect() as conn:
        return [dict(r) for r in conn.execute(sql + " ORDER BY k.id", params).fetchall()]


def delete_api_key(key_id: int) -> bool:
    with _connect() as conn:
        return conn.execute("DELETE FROM api_keys WHERE id = ?", (key_id,)).rowcount > 0


def verify_api_key(secret: str) -> dict | None:
    key_hash = hashlib.sha256(secret.encode()).hexdigest()
    with _connect() as conn:
        row = conn.execute(
            "SELECT k.id, u.id AS user_id, u.username, u.role FROM api_keys k"
            " JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?",
            (key_hash,),
        ).fetchone()
        if row is None:
            return None
        conn.execute("UPDATE api_keys SET last_used_at = ? WHERE id = ?", (int(time.time()), row["id"]))
    return {"user_id": row["user_id"], "username": row["username"], "role": row["role"]}
