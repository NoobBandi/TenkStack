"""Conversation history, in the console's SQLite database.

Two tables, conversations and messages, which is the shape every survey of this
problem lands on. Branching (a `parent_message_id`) is deliberately absent: it
doubles the UI's complexity and nothing here asks for it. Regenerating truncates
and replaces, which is what the interface already did before history existed.

Titles are taken from the first user message rather than generated. On a box
with one GPU, spending a generation to name a conversation competes with the
conversation itself.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from . import blobs, db, paths

logger = logging.getLogger(__name__)

DB_PATH = paths.DB_PATH
TITLE_LENGTH = 48


def _connect() -> sqlite3.Connection:
    # Foreign keys on top of the shared settings: deleting a conversation is
    # supposed to take its messages with it, and SQLite does not enforce that
    # unless asked, per connection.
    conn = db.connect()
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init() -> None:
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                title TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL DEFAULT '',
                -- The sampling settings in force, so reopening a conversation
                -- restores the conditions it was held under rather than
                -- whatever the panel happens to show now.
                params TEXT NOT NULL DEFAULT '{}',
                pinned INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL
                    REFERENCES conversations(id) ON DELETE CASCADE,
                seq INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                reasoning TEXT,
                -- Data URIs. Inline rather than on disk: a household's worth of
                -- attachments is small, and one file to back up beats two
                -- stores that can disagree.
                images TEXT,
                -- usage, timings, finish_reason, ttft_ms as one JSON blob:
                -- display-only, never queried, so columns would earn nothing.
                meta TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_conversation
                ON messages(conversation_id, seq);
            CREATE INDEX IF NOT EXISTS idx_conversations_updated
                ON conversations(pinned DESC, updated_at DESC);
            """
        )


def _title_from(messages: list[dict]) -> str:
    first = next((m for m in messages if m.get("role") == "user"), None)
    text = (first or {}).get("content", "").strip().replace("\n", " ")
    if not text:
        return "新對話"
    return text[:TITLE_LENGTH] + ("…" if len(text) > TITLE_LENGTH else "")


def list_conversations(user_id: int | None = None, limit: int = 200) -> list[dict]:
    sql = """
        SELECT c.id, c.title, c.model, c.pinned, c.created_at, c.updated_at,
               (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
        FROM conversations c
    """
    params: tuple = ()
    if user_id is not None:
        sql += " WHERE c.user_id = ?"
        params = (user_id,)
    sql += " ORDER BY c.pinned DESC, c.updated_at DESC LIMIT ?"
    with _connect() as conn:
        rows = conn.execute(sql, (*params, limit)).fetchall()
    return [dict(r) for r in rows]


def get_conversation(conversation_id: int) -> dict | None:
    with _connect() as conn:
        head = conn.execute(
            "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
        ).fetchone()
        if head is None:
            return None
        rows = conn.execute(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq",
            (conversation_id,),
        ).fetchall()

    def unpack(row: sqlite3.Row) -> dict:
        message = {"role": row["role"], "content": row["content"]}
        if row["reasoning"]:
            message["reasoning"] = row["reasoning"]
        for column in ("images", "meta"):
            if row[column]:
                try:
                    value = json.loads(row[column])
                except json.JSONDecodeError:
                    continue
                if column == "meta" and isinstance(value, dict):
                    message.update(value)
                elif column == "images":
                    # References become URLs; a data URI from before there was
                    # a blob directory is passed through and still renders.
                    message[column] = blobs.to_urls(value)
                else:
                    message[column] = value
        return message

    result = dict(head)
    try:
        result["params"] = json.loads(head["params"] or "{}")
    except json.JSONDecodeError:
        result["params"] = {}
    result["messages"] = [unpack(r) for r in rows]
    return result


def save(
    conversation_id: int | None,
    *,
    messages: list[dict],
    model: str,
    params: dict,
    user_id: int | None = None,
    title: str | None = None,
) -> dict:
    """Create or replace a conversation's messages.

    The whole message list is written each time rather than appending deltas.
    Regeneration and editing both rewrite the tail, so an append-only protocol
    would need its own reconciliation; replacing is exact and the volumes here
    are trivial.
    """
    now = int(time.time())
    payload = [
        (
            index,
            m.get("role", "user"),
            m.get("content", ""),
            m.get("reasoning") or None,
            # Written to disk first and stored as a reference. The order
            # matters: a file with no row is collected by the sweep, a row with
            # no file is a broken image.
            json.dumps(blobs.to_refs(m["images"]), ensure_ascii=False)
            if m.get("images") else None,
            json.dumps(
                # `model` is per-message, not per-conversation: a thread can be
                # continued by a different model, and attributing an old reply
                # to whichever model is selected now would misreport who said
                # what.
                # `tool_calls`, `tool_call_id` and `run` are here because a
                # conversation that used the sandbox is not reloadable without
                # them. Dropping them loses the trace, and worse, leaves an
                # assistant turn with no calls followed by tool turns with no id
                # -- a message list the server rejects on the next question.
                {k: m[k] for k in ("usage", "timings", "finish_reason", "ttft_ms",
                                   "thinking_ms", "model",
                                   "tool_calls", "tool_call_id", "run")
                 if k in m},
                ensure_ascii=False,
            ) or None,
            now,
        )
        for index, m in enumerate(messages)
    ]

    with _connect() as conn:
        if conversation_id is None:
            cursor = conn.execute(
                "INSERT INTO conversations (user_id, title, model, params, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (user_id, title or _title_from(messages), model,
                 json.dumps(params, ensure_ascii=False), now, now),
            )
            conversation_id = cursor.lastrowid
        else:
            existing = conn.execute(
                "SELECT title FROM conversations WHERE id = ?", (conversation_id,)
            ).fetchone()
            if existing is None:
                raise KeyError(conversation_id)
            # An empty or default title is filled in once real content arrives;
            # a title the user set is never overwritten.
            new_title = title or existing["title"] or _title_from(messages)
            conn.execute(
                "UPDATE conversations SET title = ?, model = ?, params = ?, updated_at = ?"
                " WHERE id = ?",
                (new_title, model, json.dumps(params, ensure_ascii=False), now, conversation_id),
            )
            conn.execute("DELETE FROM messages WHERE conversation_id = ?", (conversation_id,))

        conn.executemany(
            "INSERT INTO messages"
            " (conversation_id, seq, role, content, reasoning, images, meta, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [(conversation_id, *row) for row in payload],
        )

    return {"id": conversation_id}


def update(conversation_id: int, *, title: str | None = None,
           pinned: bool | None = None) -> bool:
    sets, values = [], []
    if title is not None:
        sets.append("title = ?"); values.append(title)
    if pinned is not None:
        sets.append("pinned = ?"); values.append(1 if pinned else 0)
    if not sets:
        return False
    values.append(conversation_id)
    with _connect() as conn:
        return conn.execute(
            f"UPDATE conversations SET {', '.join(sets)} WHERE id = ?", values
        ).rowcount > 0


def delete(conversation_id: int) -> bool:
    with _connect() as conn:
        return conn.execute(
            "DELETE FROM conversations WHERE id = ?", (conversation_id,)
        ).rowcount > 0


def search(query: str, user_id: int | None = None, limit: int = 50) -> list[dict]:
    """Title and body search, so a conversation can be found by what was said in
    it rather than only by how it was named."""
    like = f"%{query}%"
    sql = """
        SELECT DISTINCT c.id, c.title, c.model, c.pinned, c.created_at, c.updated_at,
               (SELECT COUNT(*) FROM messages m2 WHERE m2.conversation_id = c.id) AS message_count
        FROM conversations c
        LEFT JOIN messages m ON m.conversation_id = c.id
        WHERE (c.title LIKE ? OR m.content LIKE ?)
    """
    params: list = [like, like]
    if user_id is not None:
        sql += " AND c.user_id = ?"
        params.append(user_id)
    sql += " ORDER BY c.pinned DESC, c.updated_at DESC LIMIT ?"
    params.append(limit)
    with _connect() as conn:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
