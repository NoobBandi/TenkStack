"""The interpreter that lives for the length of a conversation.

One process per sandbox container, started with it, holding one namespace.
Each request is a piece of code; it runs in that namespace, so a variable
defined in one call is still there in the next -- the thing the browser
sandbox could not do, and the reason an agent there kept re-deriving what it
had already computed.

Requests arrive on a unix socket, one JSON line each, from client.py, which
the console runs with `docker exec`. The container has no network, so the
socket is not an exposure: nothing outside the container can reach it, and
anything inside is already the code this exists to run.

Output is captured at the file-descriptor level rather than by swapping
sys.stdout. This is a real Linux now, and code that shells out -- subprocess,
os.system -- writes to fd 1 directly; replacing the Python object would lose
exactly that output.
"""

import ast
import base64
import io
import json
import linecache
import os
import shutil
import signal
import socket
import sys
import tempfile
import time
import traceback

SOCKET = "/tmp/kernel.sock"
PIDFILE = "/tmp/kernel.pid"
HOME = os.path.expanduser("~")

# Read back per stream. The console clips again before the model sees it;
# this only keeps a runaway print from filling the tmpfs and the pipe.
MAX_STREAM = 200_000
MAX_VALUE = 4_000
MAX_FIGURES = 8
MAX_FILES = 50
# A tree walk past this many entries is abandoned: a run that unpacked a
# large archive should not make every later run slow to report.
MAX_WALK = 5_000

namespace = {"__name__": "__main__", "__builtins__": __builtins__}
cells = 0


def prepare_matplotlib():
    """Agg, the CJK font in the chain, and a show() that does nothing.

    The cache is copied in from the image: $HOME and /tmp are empty tmpfs at
    start, and rebuilding the cache with the CJK fonts present takes seconds.

    The chain is guarded rather than set once. Code that wants Chinese names
    a font itself -- often one that is not here, sometimes the CJK one alone
    -- and either costs the glyphs the other font carried. Whatever is
    assigned keeps its place at the front; the two fonts that cover
    everything go on the end, where they are consulted only for what the
    named fonts lack.
    """
    config = "/tmp/mpl"
    if not os.path.isdir(config):
        try:
            shutil.copytree("/opt/mpl", config)
        except OSError:
            os.makedirs(config, exist_ok=True)
    os.environ["MPLCONFIGDIR"] = config

    import matplotlib

    matplotlib.use("agg")
    import matplotlib.pyplot as pyplot
    from matplotlib import font_manager

    pyplot.show = lambda *a, **k: None
    # Sans before serif, and Traditional Chinese's cut before the others:
    # the families share most glyphs, but this is the console's language.
    names = {f.name for f in font_manager.fontManager.ttflist if "CJK" in f.name}
    cjk = next((n for n in ("Noto Sans CJK TC", "Noto Sans CJK JP") if n in names),
               next((n for n in sorted(names) if "Sans" in n), next(iter(sorted(names)), None)))

    def family(value):
        names = [value] if isinstance(value, str) else list(value)
        kept = [n for n in names if n not in (cjk, "DejaVu Sans")]
        return kept + ([cjk] if cjk else []) + ["DejaVu Sans"]

    assign = matplotlib.RcParams.__setitem__

    def guard(self, key, value):
        assign(self, key, family(value) if key == "font.family" else value)

    matplotlib.RcParams.__setitem__ = guard
    matplotlib.rcParams["font.family"] = matplotlib.rcParams["font.family"]
    matplotlib.rcParams["axes.unicode_minus"] = False
    return family


try:
    font_family = prepare_matplotlib()
except Exception:  # A kernel without plotting still runs code.
    font_family = None


def harvest():
    """Every open figure as a PNG, then closed so the next run starts clean.

    Only when pyplot was imported -- by this run or an earlier one, since the
    namespace persists. A font named on one label never went through
    rcParams, so the artists are repaired here, at the last moment before the
    glyphs are chosen.
    """
    if "matplotlib.pyplot" not in sys.modules:
        return []
    import matplotlib.pyplot as plt
    from matplotlib.text import Text

    images = []
    for num in plt.get_fignums()[:MAX_FIGURES]:
        fig = plt.figure(num)
        if font_family:
            for text in fig.findobj(Text):
                text.set_fontfamily(font_family(text.get_fontfamily()))
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=110, bbox_inches="tight")
        images.append("data:image/png;base64," + base64.b64encode(buf.getvalue()).decode())
    plt.close("all")
    return images


def snapshot():
    """What is in the working directory, by path: size and mtime."""
    seen = {}
    for root, dirs, files in os.walk(HOME):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d != "__pycache__"]
        for name in files:
            if name.startswith("."):
                continue
            path = os.path.join(root, name)
            try:
                st = os.stat(path)
            except OSError:
                continue
            seen[os.path.relpath(path, HOME)] = (st.st_size, st.st_mtime_ns)
            if len(seen) >= MAX_WALK:
                return seen
    return seen


def changed(before, after):
    out = [
        {"path": path, "size": size}
        for path, (size, mtime) in sorted(after.items())
        if before.get(path) != (size, mtime)
    ]
    return out[:MAX_FILES]


def user_traceback(error):
    """The traceback from the code's own frames down, without this file's."""
    tb = error.__traceback__
    while tb is not None and tb.tb_frame.f_code.co_filename == __file__:
        tb = tb.tb_next
    if isinstance(error, SyntaxError):
        return "".join(traceback.format_exception_only(type(error), error))
    return "".join(traceback.format_exception(type(error), error, tb))


def read_back(handle):
    handle.seek(0)
    data = handle.read(MAX_STREAM + 1)
    text = data[:MAX_STREAM].decode("utf-8", "replace")
    return text, len(data) > MAX_STREAM


def run(code):
    """One cell: exec everything, and eval a trailing expression the way a
    REPL answers it."""
    global cells
    cells += 1
    filename = f"<cell {cells}>"
    # Registered so a traceback can quote the line that failed.
    linecache.cache[filename] = (len(code), None, code.splitlines(True), filename)

    before = snapshot()
    out_file = tempfile.TemporaryFile(dir="/tmp")
    err_file = tempfile.TemporaryFile(dir="/tmp")
    sys.stdout.flush()
    sys.stderr.flush()
    saved_out, saved_err = os.dup(1), os.dup(2)
    os.dup2(out_file.fileno(), 1)
    os.dup2(err_file.fileno(), 2)

    started = time.monotonic()
    value = error = None
    interrupted = False
    try:
        tree = ast.parse(code, filename, "exec")
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
        exec(compile(tree, filename, "exec"), namespace)
        if last is not None:
            result = eval(compile(last, filename, "eval"), namespace)
            if result is not None:
                value = repr(result)
                if len(value) > MAX_VALUE:
                    value = value[:MAX_VALUE] + "…"
    except KeyboardInterrupt:
        interrupted = True
        error = "KeyboardInterrupt"
    except SystemExit as exit:
        # exit() ends the cell, not the kernel.
        error = f"SystemExit: {exit.code}"
    except BaseException as failure:
        error = user_traceback(failure)
    finally:
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:
            pass
        os.dup2(saved_out, 1)
        os.dup2(saved_err, 2)
        os.close(saved_out)
        os.close(saved_err)

    images = []
    try:
        images = harvest()
    except BaseException as failure:
        # Said, not swallowed: a lost figure is otherwise indistinguishable
        # from code that never drew one.
        err_file.write(f"\n[figure] {failure}".encode())
    elapsed = time.monotonic() - started

    stdout, cut_out = read_back(out_file)
    stderr, cut_err = read_back(err_file)
    out_file.close()
    err_file.close()
    return {
        "stdout": stdout,
        "stderr": stderr,
        "value": value,
        "error": error,
        "interrupted": interrupted,
        "images": images,
        "files": changed(before, snapshot()),
        "elapsed_ms": round(elapsed * 1000),
        "truncated": cut_out or cut_err,
    }


def serve():
    if os.path.exists(SOCKET):
        os.unlink(SOCKET)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCKET)
    server.listen(4)
    with open(PIDFILE, "w") as f:
        f.write(str(os.getpid()))
    while True:
        try:
            conn, _ = server.accept()
        except KeyboardInterrupt:
            # An interrupt that arrived between runs has nothing to stop.
            continue
        with conn:
            try:
                reader = conn.makefile("rb")
                line = reader.readline()
                request = json.loads(line or b"{}")
                if request.get("kind") == "run":
                    reply = run(str(request.get("code", "")))
                else:
                    reply = {"ok": True}
                conn.sendall(json.dumps(reply).encode() + b"\n")
            except KeyboardInterrupt:
                continue
            except Exception as failure:
                try:
                    conn.sendall(json.dumps({"error": f"kernel: {failure}"}).encode() + b"\n")
                except OSError:
                    pass


if __name__ == "__main__":
    os.chdir(HOME)
    signal.signal(signal.SIGINT, signal.default_int_handler)
    serve()
