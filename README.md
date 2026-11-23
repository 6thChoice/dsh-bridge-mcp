# dsh-bridge

Send **one message to a specific, already-running DeepSeek Harness (DSH) session** from
outside DSH — Claude Code, Antigravity, a shell script, or an MCP client — and get that
session's settled answer back.

It is an ordinary process-external client: it talks to the running DSH Web host over its
`/api/*` HTTP and `/api/remote.mux` WebSocket surface and mints the browser cookie itself
from `~/.dsh/.credentials.yaml`. No DSH plugin, no forked DSH build, no writes inside the
DSH checkout. Zero runtime dependencies (Node's built-in `fetch` + `WebSocket`).

## Requirements

- Node **>= 22.19**
- A running DSH Web host: the desktop app, or `dsh web --no-open`
- Automatic host discovery on macOS (`lsof`), Linux (`ss`, then `lsof`), and Windows
  (`Get-NetTCPConnection`); on any other platform pass `--host` / `$DSH_BRIDGE_HOST`

Docs: [`docs/install.md`](docs/install.md) — wiring into Claude Code and Antigravity, GUI `PATH`
traps, troubleshooting · [`docs/usage.md`](docs/usage.md) — all flags, JSON contract, worked
examples · [`docs/spec.md`](docs/spec.md) — the binding contract and the verified wire facts.

## Quickstart

```sh
cd <path-to-dsh-bridge-mcp>
npm install
npm run build
npm link

# Find the target session (read-only, also the auth/connectivity check)
dsh-bridge sessions --limit 5

# Send to the newest session and print only its final assistant text
SESSION=$(dsh-bridge sessions --latest | cut -f1)
dsh-bridge send "What are you working on?" --session "$SESSION"

# Same thing as one JSON object
dsh-bridge send "ping" --session "$SESSION" --json
```

`send` returns when that message's **own turn** ends, not when the session looks idle.
If another turn is already running, the prompt is queued (default mode) and this waits for
its own turn; a 180 s default timeout surfaces `status: "timeout"` rather than an earlier
turn's text.

## Targets

Exactly one selector family per `send`/`result` call; filters AND together.

```sh
dsh-bridge send "hi" --session <id-prefix>     # exact id or unique prefix (session- ignored)
dsh-bridge send "hi" --title "ticket t1"       # case-insensitive title substring
dsh-bridge send "hi" --cwd <path-to-project>   # exact realpath-normalized cwd
dsh-bridge send "hi" --latest                  # newest updatedAt
```

No selector is an error. More than one match is an error listing up to ten candidates.
`dsh-bridge sessions` takes the same filters and lists every match.

## Output and exit codes

Plain `send`/`result` prints only the final assistant text (no headers, no ANSI).
`--json` prints exactly one object:

```json
{"rpcId":"…","sessionId":"…","from":"cli","turn":7,"status":"completed",
 "reason":{"kind":"completed"},"text":"…","toolCalls":[{"name":"bash","ok":true}],
 "durationMs":12345,"usage":{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0},
 "host":"http://127.0.0.1:49904"}
```

| exit | meaning |
|---|---|
| 0 | completed (incl. `max-tokens`) or `--detach` accepted |
| 2 | `status: "timeout"` |
| 3 | turn ended in `error` / `cancelled` |
| 1 | local error (args, resolution, auth, unreachable host, protocol mismatch) |

## Long turns, detach, read-back

```sh
# Return the rpcId immediately, finish reading later
dsh-bridge send "run the long job" --session "$SESSION" --detach
dsh-bridge result --rpc-id <id>              # pending -> exit 0, nothing printed yet
dsh-bridge result --rpc-id <id> --wait       # block until it ends
dsh-bridge result --rpc-id <id> --json
```

Every accepted send is recorded immediately in the append-only
`$DSH_HOME/dsh-bridge/sends.jsonl` (best-effort). If the index is unavailable, `result`
falls back to scanning the tail of the 50 most recently updated sessions.

Other useful flags: `--from <name>` (prefix `[via <name>] `, default `cli` or
`$DSH_BRIDGE_FROM`), `--no-prefix`, `--steer`, `--timeout <seconds>` (or
`$DSH_BRIDGE_TIMEOUT`), `--force` (send to a session with `agentAvailable: false`).

## Host discovery

Order: `--host <url>` → `$DSH_BRIDGE_HOST` → the optional config file
(`${XDG_CONFIG_HOME:-~/.config}/dsh-bridge/config.json`, keys `url`, `host`, `dshHome`) →
auto-detect loopback listeners owned by you whose process command mentions DeepSeek
Harness/dsh. Every auto-detected candidate must pass a cookie-authenticated `session/list`
before it is used. `--dsh-home <dir>` → `$DSH_HOME` → config `dshHome` selects the
credentials and send index; default `~/.dsh`.

## Development

```sh
npm run typecheck   # src + tests, strict
npm test            # unit tests + staging integration (spawned dsh web + stub provider)
```

Integration tests never prompt a real session: they spawn a disposable DSH with a temp
`DSH_HOME` and a local stub model endpoint. They resolve `dsh` from `DSH_BIN` → `dsh` on
`PATH` → the macOS app bundle, and self-skip (with a reason) when none is runnable, so a
clean CI runner stays green. See `docs/spec.md` for the binding contract.
