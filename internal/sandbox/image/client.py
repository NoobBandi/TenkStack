"""The console's side of the kernel, run with `docker exec` for each request.

    client.py ping           is the kernel up
    client.py run            code on stdin as {"code": ...}, the result on stdout
    client.py interrupt      SIGINT to the kernel: stops the running cell,
                             keeps the namespace
    client.py read PATH      one file from the working directory, raw on stdout

Kept apart from the kernel so that the kernel's only input is the socket, and
so that reading a file does not have to wait behind a cell that is running.
"""

import json
import os
import signal
import socket
import sys

SOCKET = "/tmp/kernel.sock"
PIDFILE = "/tmp/kernel.pid"
HOME = os.path.expanduser("~")
MAX_READ = 50 * 1024 * 1024


def ask(request):
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    conn.connect(SOCKET)
    conn.sendall(json.dumps(request).encode() + b"\n")
    reply = conn.makefile("rb").readline()
    if not reply:
        raise SystemExit("kernel closed the connection without answering")
    sys.stdout.buffer.write(reply)


def read(path):
    # Inside the working directory and nowhere else, resolved first so a
    # symlink cannot lead out of it.
    full = os.path.realpath(os.path.join(HOME, path))
    if os.path.commonpath([full, HOME]) != HOME or not os.path.isfile(full):
        sys.stderr.write("not found\n")
        raise SystemExit(2)
    if os.path.getsize(full) > MAX_READ:
        sys.stderr.write("too large\n")
        raise SystemExit(3)
    with open(full, "rb") as f:
        while chunk := f.read(1 << 20):
            sys.stdout.buffer.write(chunk)


def main():
    verb = sys.argv[1] if len(sys.argv) > 1 else ""
    if verb == "ping":
        ask({"kind": "ping"})
    elif verb == "run":
        ask({"kind": "run", "code": json.load(sys.stdin).get("code", "")})
    elif verb == "interrupt":
        with open(PIDFILE) as f:
            os.kill(int(f.read().strip()), signal.SIGINT)
    elif verb == "read" and len(sys.argv) > 2:
        read(sys.argv[2])
    else:
        raise SystemExit("usage: client.py ping|run|interrupt|read PATH")


if __name__ == "__main__":
    main()
