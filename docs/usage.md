# Usage

Three commands. `send` is the kernel; `result` reads a send back; `sessions` finds targets.

## Targeting

Exactly one family per `send`; families AND together, so `--cwd` + `--latest` is a good default.

```sh
dsh-bridge sessions --limit 5                  # newest 5
dsh-bridge sessions --cwd ~/code/proj          # everything for one working directory
dsh-bridge sessions --title "因子失效" --json   # title search, machine-readable
```

| flag | meaning |
|---|---|
| `--session <id\|prefix>` | exact id, or a unique prefix; a leading `session-` is ignored on both sides |
| `--title <substr>` | case-insensitive substring of the session title |
| `--cwd <path>` | exact working directory, `realpath`-normalized |
| `--latest` | newest `updatedAt` among the rows the other filters kept |

No selector → error. More than one match → error listing up to 10 candidates; narrow it rather than
letting the tool guess.

## `send`

```sh
dsh-bridge send "where did you get to on the polymarket ingest?" --title "polymarket" --latest
```

Prints **only** the final assistant text of the turn that consumed this message, then exits.
Nothing else goes to stdout, so it can be pasted into another agent's tool result verbatim.

| flag | default | meaning |
|---|---|---|
| `--from <name>` | `$DSH_BRIDGE_FROM` or `cli` | sender label put in the visible prefix `[via <name>] ` |
| `--no-prefix` | off | send the raw text with no `[via …]` prefix |
| `--steer` | off | `steer` instead of `queue` (inject into the running turn, not after it) |
| `--detach` | off | return the `rpcId` immediately instead of waiting |
| `--timeout <seconds>` | `180` (or `$DSH_BRIDGE_TIMEOUT`) | how long to wait for the turn to end |
| `--force` | off | allow a target whose `agentAvailable` is `false` |
| `--json` | off | print the JSON verdict instead of plain text |

Completion is decided by the session log, not by quiet polling: the bridge waits for the
`user/message` carrying its own `requestId`, remembers the turn that message landed in, and waits
for that turn's `turn/end`. A message queued behind a running turn therefore returns **its own**
turn's answer, never the previous one.

### Timeouts and long handoffs

A blocking `send` is bounded by the *caller's* tool timeout as well as `--timeout` — Claude Code's
Bash tool tops out at 10 minutes, for example. For anything longer, detach:

```sh
rpc=$(dsh-bridge send "run the full backtest and report IC" --cwd ~/code/proj --latest --detach)
# … do other work …
dsh-bridge result --rpc-id "$rpc" --wait --timeout 600
```

`result` reads the session log, so it works from a later process — even after a reboot. It is
idempotent and never re-sends anything.

## `result`

```sh
dsh-bridge result --rpc-id <id>            # one look: completed | pending | error | cancelled
dsh-bridge result --rpc-id <id> --wait     # block until the turn ends
dsh-bridge result --rpc-id <id> --json     # same JSON contract as send --json
```

Lookup uses the append-only index `~/.dsh/dsh-bridge/sends.jsonl`; if the id is not there (another
machine, cleared home), it scans the 50 most recently updated sessions for the matching `rpcId`.

## JSON contract

`send --json` and `result --json` print exactly one object:

```json
{
  "rpcId": "8a7b6ef7-…",
  "sessionId": "session-474d640c-…",
  "from": "claude-code",
  "turn": 7,
  "status": "completed",
  "reason": { "kind": "completed" },
  "text": "…",
  "toolCalls": [{ "name": "bash", "ok": true }],
  "durationMs": 12345,
  "usage": { "inputTokens": 4576, "outputTokens": 15221, "cacheReadTokens": 1731072 },
  "host": "http://127.0.0.1:49904"
}
```

`status` ∈ `completed | error | cancelled | timeout | pending`. Mapping from `turn/end`:
`completed`→`completed`, `max-tokens`→`completed` (raw kind kept in `reason`), `aborted`→`cancelled`,
`blocked`/`error`/unknown→`error`. `pending` only appears for `--detach` and for `result` on a turn
that has not ended. While `pending`, `text` is empty — plain mode prints nothing and exits 0, and what
settled so far is available only as `--json`'s optional `partialText`. A `timeout` does keep its
settled `text`. `sessions --json` returns the raw `session/list` rows instead.

`pending` means "no verdict in the durable log yet"; it can also mean the prompt was dropped before
admission or fell outside the read window, so treat it as *unknown*, not as proof the turn is alive
(see `docs/backlog.md` P2-3).

### Exit codes

| code | meaning |
|---|---|
| 0 | completed, or `--detach` accepted, or `result` still pending |
| 2 | timeout — read it later with `result --rpc-id` |
| 3 | the turn ended in `error` or `cancelled` |
| 1 | local failure: bad arguments, no/ambiguous target, auth, host unreachable, protocol error |

On timeout, plain mode keeps stdout text-only and puts the `rpcId` plus the read-later hint on
stderr, so a caller that only parses stdout can never mistake a partial turn for a finished one.

## MCP tools (Claude Code, Antigravity)

| tool | arguments |
|---|---|
| `dsh_send` | `{target:{session?,title?,cwd?,latest?}, text, from?, timeoutSeconds?, detach?, prefix?}` |
| `dsh_result` | `{rpcId, wait?, timeoutSeconds?}` |
| `dsh_sessions` | `{session?,title?,cwd?,latest?,limit?}` |

`structuredContent` carries the JSON object above; `content[0].text` carries the plain rendering
(the assistant text, the `rpcId` while pending, otherwise the status line or timeout hint).
`isError: true` mirrors CLI exit codes 2/3/1 — a tool client that reads only the text still cannot
mistake a failed turn for a successful one. MCP defaults: `timeoutSeconds` 3600, `from` `mcp`.

## Worked examples

**1. Hand a task to another session and take the answer back.**

```sh
dsh-bridge send "你们 polymarket 那套数据管线现在还能跑吗？只回结论" \
  --cwd /Users/zhouxuancheng/CodeBase/deepseek-harness/polymarket --latest
```

The other session runs its own turn with its own context and tools; the text comes back on stdout
and can be pasted straight into the calling harness's tool result.

**2. Long handoff, then poll.**

```sh
dsh-bridge send "把 seed44 的滚动挖掘重跑到收敛，结束后只回 IC 和淘汰率" \
  --title "seed44" --latest --detach
# 1730 秒后…
dsh-bridge result --rpc-id 90eb72e9-0843-44eb-b07e-2323a5041ca4 --json
```

**3. Which session am I even talking to?**

```sh
dsh-bridge sessions --cwd ~/Documents/Agent/deepseek-harness --limit 10
```
