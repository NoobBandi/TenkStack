# Security

## Reporting a vulnerability

Please report it privately, through GitHub's private vulnerability reporting:
the **Report a vulnerability** button under the **Security** tab of
[NoobBandi/TenkStack](https://github.com/NoobBandi/TenkStack/security), which
opens a draft security advisory only the maintainers can see. Do not open a
public issue for it.

Say what an attacker needs to start with (network reach to which port, a
member account, an administrator account, a local OS account on the host),
what they get, and the steps or a proof of concept. The version from the 關於
page or `tenkstack -version` helps. This is a project maintained in spare
time, so there is no fixed response time, but a private report is read before
anything else.

Only the latest release is supported; a fix ships as a new release, which
every installation is offered on its 關於 page.

## The security model

TenkStack is built for one machine shared by a handful of people who trust its
owner. It is not a multi-tenant service, and several of its boundaries are
deliberately the operating system's rather than its own. Knowing where they are
matters more than any one feature.

**Until the first account exists, only the setup link gets in.** With no
account there is nobody to sign in as, and whoever reached the console first
would make themselves its administrator. So the console writes a random setup
token to `setup-token` in its state directory (mode 0600), and the installer
prints the console's address with `?setup=<token>` on the end. Opening that
link gives the browser a cookie that admits it; every other request is turned
away. The token is deleted when the first account is created, and from then on
accounts are the only way in. Create the administrator account soon after
installing all the same: anyone who can read the link, or the console's log,
can use it until then.

**Administrator and member.** The first account is the administrator. A member
can use the machine: chat, load and unload models, use ComfyUI, and manage
their own password and API keys. Changing it for everyone — accounts, models
and what is on disk (the file browser included), settings, the llama-swap
config, engines, which channels are open to the internet, ComfyUI's version,
benchmarks — is the administrator's, and is checked on the server for every
such route, not only hidden in the interface.

**API keys reach only `/v1`.** A key is for a client of the model API (Claude
Code, Codex, a script); the console's own `/api` refuses it and wants a
signed-in browser session instead. A leaked key can use the models as its
owner, and nothing else.

**The console's administrator is effectively root on the host.** The console
runs as an ordinary user, but the installer puts that user in the `docker`
group so the console can run ComfyUI, the inference engines, PostgreSQL and
the Python sandbox — and membership of `docker` is equivalent to root. The
administrator can also edit llama-swap's `config.yaml`, whose entries are
command lines, and read and write files as the console's user. The console
limits itself — the file browser refuses its own state directory and the usual
credential directories — but that is a guard rail, not a boundary. Give the administrator
account only to someone you would give root.

**Members can run code in ComfyUI.** ComfyUI is served behind the console's
login, and the console enables ComfyUI-Manager's "Install via Git URL", so a
signed-in member can install custom nodes — third-party code that runs inside
that ComfyUI container, with its card and its storage. The container does not
receive the console's session cookie.

**Loopback is not a boundary between local users.** llama-swap (`:8080`), the
inference servers it starts, ComfyUI (`:8188` and up) and SearXNG (`:8090`)
listen on `127.0.0.1` and have no authentication of their own. Caddy is the
only thing reachable from the network, and it puts the console's login in
front of everything it serves. But any other OS user on the same machine, or
any process there, can talk to those ports directly — use the models, drive
ComfyUI, read llama-swap's request log. If the host has users you do not trust
with those, TenkStack is the wrong shape for it. The database is not in that
list: PostgreSQL has no TCP listener and its socket is in a directory only the
console's user can enter.

**Plain HTTP is plain.** Installed without `--tls` or `--domain`, the console
is served over HTTP on `:8443`, and passwords, session cookies and API keys
cross the network readable. That is meant for a network you trust or for a
proxy in front that terminates TLS (Cloudflare Tunnel, Tailscale Serve, an
ingress). The plain-HTTP `/v1` port (`:8000`) carries API keys the same way.

**The agent's Python runs under gVisor, without a network.** When Docker has
the `runsc` runtime, the code a model writes runs on the server in one
container per conversation: gVisor's sentry answers its system calls instead
of the host kernel, with no network, no mounts, a read-only root, size-capped
tmpfs, and memory, CPU and process limits; the code travels on stdin rather
than in Docker's arguments. Without `runsc` nothing runs on the server; the
chat falls back to Python in the browser (Pyodide), inside a sandboxed frame
with an opaque origin that cannot reach the console. Plain Docker is never
used as a weaker substitute for gVisor.

**What must never leave the machine.** `session.key` in the state directory
signs every login, so whoever has it can forge one; the database holds
password hashes and API keys; `huggingface-token` opens gated models on the
owner's Hugging Face account. All three live under `$CONSOLE_STATE_DIR`, which
the file browser refuses to open and `.gitignore` keeps out of commits.

**Updates.** Each installation asks GitHub for the latest release itself. An
update fetches the release binary and checks it against the release's
`SHA256SUMS` before swapping it in. The checksums come from the same release
as the binary, so this catches a damaged download, not a compromised GitHub
account.
