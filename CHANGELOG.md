# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — unreleased

First public release as `dsh-bridge-mcp`.

### Added

- `dsh-bridge send` — one message to a specific existing DSH session; returns the answer of the
  turn that consumed that message (`queue` by default, `--steer` available).
- `dsh-bridge result` — read a send back by `rpcId` from the durable session log, `--wait` to block;
  survives the sending process being killed.
- `dsh-bridge sessions` — list and resolve targets by exact id, id prefix, title substring, or
  working directory, with `--latest`.
- `dsh-bridge-mcp` — stdio MCP server exposing `dsh_send`, `dsh_result`, `dsh_sessions`.
- Two authentication paths, chosen automatically: DSH's launch URL token exchange, and minting the
  browser cookie from DSH's own credential record.
- `dsh-bridge doctor` — host, auth path, reachability, visible-session count, and the next step for
  every failing check.
- `dsh-bridge setup <harness>` — prints a ready-to-paste MCP configuration generated on the machine
  running it; `--write` for Claude Code and Antigravity.
- `examples/` — per-harness wiring for Claude Code, Antigravity, Codex, Cursor, Cline, Continue, Zed,
  plus remote-host usage.
- Cross-platform host discovery: macOS `lsof`, Linux `ss`/`lsof`, Windows `Get-NetTCPConnection`.

### Known limitations

- Authentication depends on DSH's browser-cookie scheme, which is internal: a DSH release can break
  it. `doctor` makes the failure obvious; `docs/protocol.md` records what was verified.
- A blocking `send` is bounded by the calling harness's own tool timeout as well as `--timeout`;
  use `--detach` + `result` for long handoffs.
- `result` reporting `pending` means "no verdict in the durable log yet", which can also mean the
  prompt was dropped or fell outside the read window — not proof the turn is alive.
- A dropped follow socket is not retried; the answer is still readable with `result`.
- `--steer` into a turn already running for a long time can fail after delivery (see
  `docs/backlog.md`).
