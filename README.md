# dsh-bridge-mcp

[中文](README.zh.md) · English

[![npm](https://img.shields.io/npm/v/dsh-bridge-mcp?style=flat-square)](https://www.npmjs.com/package/dsh-bridge-mcp)
[![ci](https://github.com/6thChoice/dsh-bridge-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/6thChoice/dsh-bridge-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-374151.svg)](LICENSE)

**Hand one task to an existing DeepSeek Harness session from Claude Code, Antigravity, Codex, or any
other agent — and get that session's answer back.**

You already have a DSH session holding the context, tools, and half-finished work for something. This
lets another harness — or a shell script — ask it a question, wait for *that message's own turn* to
finish, and read the answer as plain text.

```sh
dsh-bridge send "where did you get to on the ingest?" --title "polymarket" --latest
```

- One message in, one answer out. No session is created, nothing is forked.
- The answer is the turn that consumed **your** message — never an earlier turn that happened to be
  running when you sent it.
- Long jobs: `--detach` returns an `rpcId`; `dsh-bridge result --rpc-id <id> --wait` picks the
  verdict up later, from a different process, after a reboot.
- Works against a **remote** DSH host, not just the local process.
- Zero runtime dependencies, Node ≥ 22.19.

## Why not just install a DSH plugin?

There is an existing in-host plugin with a similar purpose
([`dsh-bridge`](https://github.com/baixianger/dsh-bridge) on npm, an in-process DSH plugin exposing
session messaging to the host's own agents). Both are reasonable; they sit in different places:

| | A DSH plugin | `dsh-bridge-mcp` (this) |
|---|---|---|
| Install | added to a DSH profile, fenced by DSH plugin version requirements | nothing added to DSH; a client, like a browser tab |
| Reach | only the local host process | any reachable DSH Web host, including remote over TLS |
| Caller | DSH's own agents | any harness: Claude Code, Antigravity, Codex, scripts |
| Completion | delivery acknowledgement (the host accepted the message) | waits for the turn that consumed your message, with exit codes |
| Cost | follows DSH's plugin API | depends on DSH's browser-cookie authentication, so a DSH release can require a fix here |

Pick the plugin if you want DSH agents messaging each other inside one host. Pick this if the caller
lives outside DSH, or if the host is on another machine.

## Install

Nothing to install (recommended for MCP):

```sh
npx -y dsh-bridge-mcp
```

Globally, which gives you both commands — `dsh-bridge` (CLI) and `dsh-bridge-mcp` (MCP server):

```sh
npm i -g dsh-bridge-mcp
```

From source:

```sh
git clone https://github.com/6thChoice/dsh-bridge-mcp
cd dsh-bridge-mcp && npm install && npm run build && npm link
```

## 60 seconds

```sh
dsh-bridge doctor            # host, auth path, reachability, and the fix for anything failing
dsh-bridge sessions --limit 5
dsh-bridge send "reply with the single word PONG" --cwd ~/code/my-project --latest
```

Wire it into a harness — `setup` prints a block generated from *your* machine:

```sh
dsh-bridge setup claude-code           # or antigravity, codex, cursor, cline, continue, zed, raw
dsh-bridge setup claude-code --write   # applies it (Claude Code and Antigravity only)
```

Copy-paste configurations for every supported harness live in [`examples/`](examples/) — including
[`examples/remote-host.md`](examples/remote-host.md) for a DSH on another machine. Details and
troubleshooting: [`docs/install.md`](docs/install.md).

## The commands

| command | purpose |
|---|---|
| `dsh-bridge send <text> (target)` | send one message; print the final assistant text of its turn |
| `dsh-bridge result --rpc-id <id>` | read that send back later; `--wait` blocks until it ends |
| `dsh-bridge sessions (target)` | list and resolve sessions |
| `dsh-bridge doctor` | diagnose host, auth path, reachability |
| `dsh-bridge setup <harness>` | emit MCP configuration for this machine |

Targets: `--session <id\|prefix>`, `--title <substr>`, `--cwd <path>`, `--latest`. Exactly one
family; no selector is an error, several matches is an error listing candidates. Full reference:
[`docs/usage.md`](docs/usage.md).

MCP tools: `dsh_send`, `dsh_result`, `dsh_sessions` — same semantics; `structuredContent` carries the
JSON verdict and `isError` mirrors the CLI exit code.

## It tells you the truth

- Plain stdout is **only** the final assistant text — safe to paste into another agent's tool result.
- `--json` gives `rpcId`, `sessionId`, `turn`, `status`, `reason`, `text`, `toolCalls[{name,ok}]`,
  `durationMs`, `usage`, `host`.
- Exit codes: `0` completed (or detached, or still pending), `2` timeout, `3` the turn ended in
  error/cancelled, `1` local failure. On timeout the `rpcId` and a read-later hint go to **stderr**,
  so a caller that only parses stdout cannot mistake a partial turn for a finished one.
- A still-running turn never prints text: `pending` means "no verdict in the durable log yet".

## Authentication

Two paths, chosen automatically, both producing an ordinary DSH browser session:

1. **Launch URL token** — the `http://127.0.0.1:<port>/?token=…` URL that `dsh web` prints. This is
   DSH's public flow; the token is exchanged for the browser cookie and works across machines and
   DSH versions.
2. **Credential minting** — reads `$DSH_HOME/.credentials.yaml` (`client-connection/browser-session`)
   and signs the browser cookie for the target host. Zero user steps; needed for the desktop app,
   which never prints its launch URL.

The cookie is held in memory only and never printed. `doctor` reports which path was used.
Read [`SECURITY.md`](SECURITY.md) before pointing this at a host you do not control: sending a prompt
can make that host's agent run tools, so treat the bridge like the DSH composer itself.

## Known limitations

- Authentication follows DSH internals (cookie scheme, credential record). A DSH release can break
  it; `doctor` makes that obvious and [`docs/protocol.md`](docs/protocol.md) records exactly what was
  verified. Verified against DSH `0.2.1-rc.2`; older `0.1.x` hosts are best-effort.
- A blocking `send` is bounded by the calling harness's own tool timeout as well as `--timeout`
  (Claude Code's Bash tool caps at 10 minutes). Use `--detach` + `result` for long handoffs.
- `result` reporting `pending` is not proof the turn is alive — it can also mean the prompt was
  dropped or fell outside the read window.
- A dropped follow socket is not retried; the answer remains readable with `result`.
- `--steer` into a turn that has been running for a long time can fail after delivery.

The full list, with file references, is [`docs/backlog.md`](docs/backlog.md).

## Development

```sh
npm install && npm run build
npm run typecheck && npm test
```

Integration tests spawn a disposable `dsh web` with a temp `DSH_HOME` and a local stub model
provider — no real model call, no real session touched — and self-skip when no `dsh` binary exists.
See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT © 2026 6thChoice. See [`LICENSE`](LICENSE).
