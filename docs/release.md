# Release contract — open-source v1 (`dsh-bridge-mcp`)

Decided by the project owner on 2026-11-23. Implementers do not reopen these decisions.

## Identity

| Field | Value |
|---|---|
| GitHub repo | `https://github.com/6thChoice/dsh-bridge-mcp` |
| npm package | `dsh-bridge-mcp` (free at decision time) |
| Bins | `dsh-bridge` (CLI) and `dsh-bridge-mcp` (MCP stdio server) — the other npm package named `dsh-bridge` is a DSH *plugin* and ships no bin, so the command name does not collide |
| License | MIT, `Copyright (c) 2026 6thChoice` |
| Author identity | `6thChoice <6thChoice@users.noreply.github.com>` |
| Node | `>= 22.19`, zero runtime dependencies |
| README | English primary (`README.md`) + `README.zh.md`, both linked |

Renaming note: the historical name in tickets/spec prose is `dsh-bridge`; the *package* becomes
`dsh-bridge-mcp`. The CLI command stays `dsh-bridge`, so existing docs remain valid.

## Positioning (must appear in README, honestly)

`dsh-bridge-mcp` is a **process-external client**: it drives a running DeepSeek Harness Web host
over that host's own HTTP/WS API, from any other agent harness. Compare with the existing
[`dsh-bridge`](https://github.com/baixianger/dsh-bridge) npm package, which is an in-host **DSH
plugin** exposing session messaging to the host's own agents. Do not disparage it; state the
difference factually:

- no DSH install step, no plugin version fence, nothing added to the DSH profile;
- works against a *remote* DSH host (not just the local process);
- long handoffs: a blocking `send` returns the answer of the turn that consumed **your** message;
  `--detach` + `result` survives the caller process;
- cost: it depends on DSH's browser-cookie scheme, so a DSH version bump can require a fix. Say so
  plainly in "Known limitations".

## Authentication — two paths, automatic

Precedence:

1. **URL token** — `--url <origin>/?token=…` or `DSH_BRIDGE_URL`. Exchange with
   `GET <url>` + `redirect: 'manual'`; a `303` with `Set-Cookie` yields the browser cookie.
   This is DSH's public launch flow (`dsh web` prints that URL). No internal knowledge, works
   remotely, survives DSH cookie-scheme changes.
2. **Credential minting** — read `$DSH_HOME/.credentials.yaml`
   (`client-connection/browser-session` → 32-byte base64url secret) and mint the signed cookie for
   the target authority (spec §3.1). Zero user steps; required for the desktop app, whose token is
   not printed anywhere.

Rules: the URL path wins when both are configured; `doctor` must say which path was used; the cookie
is held **in memory only** (never written to disk); no secret or cookie value may be printed at any
verbosity, ever; `--json` output must be free of them too.

Failures must name the fix, not just the cause: e.g. "no credentials at $DSH_HOME and no
DSH_BRIDGE_URL set — for `dsh web` paste the printed URL, for the desktop app start DSH once with
its Web host so the credential record exists".

## Portability — no machine-specific paths in tracked files

Discovery ladder: `--host` → `DSH_BRIDGE_HOST` (origin form) → config file → platform discovery.

Config file: `${XDG_CONFIG_HOME:-~/.config}/dsh-bridge/config.json`, optional:

```json
{ "url": "http://127.0.0.1:49904/?token=…", "host": "http://127.0.0.1:49904", "dshHome": "~/.dsh" }
```

Discovery by platform: macOS `lsof` (unchanged), Linux `ss -ltnp` then `lsof`, Windows
`Get-NetTCPConnection` via `powershell -NoProfile` — each confirmed by an authenticated
`session/list`. If none can run, fail with the explicit `--host`/`DSH_BRIDGE_URL` hint (and say
`DSH_BRIDGE_HOST` rather than `--host` when the caller is the MCP server).

Staging tests must resolve a runnable `dsh` from: `DSH_BIN` env → `dsh` on `PATH` → the macOS app
path — and **self-skip** (not fail) when none exists, so CI on a clean runner stays green.

Documentation and examples: no absolute user paths, no `nvm` paths, no usernames. Use
`<absolute-path-to-node>`, `$(command -v node)`, `npx dsh-bridge-mcp`, or `process.execPath`
generated output.

## New commands

### `dsh-bridge doctor [--json]`

One screen, and the first thing a new user runs. Reports, in order: resolved host (and how it was
resolved), auth path (`url-token` / `credentials`), cookie accepted (a real authenticated
`session/list` probe), number of visible sessions, DSH reachability latency, and for every failing
check the concrete next step. Exit 0 only if the bridge can actually send.

### `dsh-bridge setup <harness> [--write] [--from <name>]`

Prints a ready-to-paste MCP server block generated from **the machine running it**
(`process.execPath` + the resolved package path, or `npx dsh-bridge-mcp` when installed from npm).
Harnesses: `claude-code`, `antigravity`, `codex`, `cursor`, `cline`, `continue`, `zed`, `raw`.
Default is print-only; `--write` is allowed **only** for `claude-code` (delegate to
`claude mcp add`) and `antigravity` (`~/.gemini/config/mcp_config.json`, merge, back up first with
a timestamped `.bak-dsh-bridge-mcp-*`). Everything else prints. Always print the exact command that
would be run.

`examples/` holds one file per harness with the same blocks, plus `examples/http-remote.md` for
driving a remote DSH over the URL-token path.

## Repository layout after this release

```
README.md  README.zh.md  LICENSE  SECURITY.md  CONTRIBUTING.md  CHANGELOG.md
package.json  tsconfig*.json  src/  tests/  scripts/  examples/
docs/protocol.md        # was docs/spec.md — the wire contract, public and linkable
docs/install.md  docs/usage.md  docs/backlog.md
docs/dev/               # T1/T2/T3 tickets + release notes: process evidence, not marketing
.github/workflows/ci.yml  .github/ISSUE_TEMPLATE/bug_report.yml
```

- `docs/spec.md` → `docs/protocol.md` (same content, public framing; keep the verified wire facts).
- Tickets move to `docs/dev/` unchanged except their internal links.
- `CHANGELOG.md` starts at `0.1.0` with one honest section.
- CI: Node 22.19 and 24, `npm ci`, `npm run typecheck`, `npm test` (staging self-skips), plus
  `npm pack --dry-run` to prove the tarball contents.
- `package.json` gains `repository`, `homepage`, `bugs`, `license`, `keywords`, `files`,
  `publishConfig.access = "public"`, `description`; scripts unchanged otherwise.

## Out of scope for v1

- Publishing itself (needs the owner's npm login) and the git push (needs the owner's GitHub
  credentials from this machine).
- Windows *sending* support beyond discovery best-effort (document as untested).
- Reconnect after a dropped follow socket (backlog P3-8), `pending` disambiguation (P2-3),
  `--steer` long-turn failure (P2-1). Documented in `docs/backlog.md`, linked from README.

## Definition of done

1. `npm run typecheck` and `npm test` green on 22.19 and 24 (CI proves it; locally at least 24).
2. `npm pack --dry-run` lists only intended files, no `dist-test/`, no `.git`, no machine paths.
3. `dsh-bridge doctor` succeeds on this machine through the credential path, and through the
   URL-token path against a staged `dsh web`.
4. `dsh-bridge setup claude-code` prints a block that, pasted into a fresh shell, resolves without
   any absolute path from this machine being hardcoded anywhere in the repo.
5. README (EN + zh) explains the two-path auth, the plugin-vs-client difference, and the known
   limitations, with working links.
6. No tracked file contains `/Users/` or a username.
