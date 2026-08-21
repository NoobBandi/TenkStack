"""One way to open the console's database.

Three modules opened it three ways, which was fine until the pragmas mattered.
They do now: the default journal mode makes a writer lock the whole file, so
the agent storing a megabyte of PNG into a message blocks another tab reading
its own history -- and the symptom, `database is locked`, reads like an
argument for a database server when it is an argument for one line of setup.

What this is not is a reason to run one. There is a single writer process on a
single machine, the whole store is eight megabytes, and every query is a
primary-key range over one conversation. A server would add a startup
dependency, credentials, a migration story and a few hundred megabytes of
resident memory -- on a host whose spare RAM now holds MoE expert tensors.
"""

from __future__ import annotations

import sqlite3

from . import paths

DB_PATH = paths.DB_PATH


def connect() -> sqlite3.Connection:
    """A connection with the settings this workload actually needs.

    * **WAL** so readers and the writer stop excluding each other. It is a
      property of the file rather than the connection, so setting it on each
      open is a no-op after the first -- and the right place for it, because
      there is no other moment every process is guaranteed to pass through.
    * **busy_timeout** so a collision waits rather than failing. Five seconds
      is far longer than any write here takes and far shorter than a person
      waits before reloading.
    * **synchronous=NORMAL**, which under WAL still cannot corrupt the database
      on a crash -- it can only lose the last transactions, and what is at risk
      is a chat message rather than anything that has to survive a power cut.

    WAL leaves `-wal` and `-shm` files beside the database. A backup that
    copies only `console.sqlite` can miss committed transactions still in the
    log; copy all three, or use `sqlite3 .backup`.
    """
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA synchronous = NORMAL")
    return conn
