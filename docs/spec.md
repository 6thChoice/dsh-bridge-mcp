# dsh-bridge — Specification (v1)

Status: decided. All decisions below are human-owned and closed; implementers do not reopen them.

## 1. Purpose

Let another agent harness (Claude Code, Antigravity, plain scripts) send one message to a
**specific existing DeepSeek Harness (DSH) session** and get that session's answer back.

Out of scope for v1: creating sessions, streaming partial output to the caller, attachments,
sending to subagent addresses, editing session state, publishing to npm.

## 2. Shape

- **Process-external client.** Talks to a running DSH Web host over its own HTTP/WS API
  (`/api/*` + `/api/remote.mux`). No DSH plugin, no forked DSH build, no writes inside the DSH
  checkout. Works for the local desktop app, a local `dsh web`, or a remote host that exposes
  the same API.
- **CLI is the kernel.** `dsh-bridge sessions|send|result`.
- **MCP is a thin shell.** `dsh-bridge-mcp` exposes three tools over stdio and delegates to the
  same core module.
- **Language/runtime:** TypeScript (strict), Node ≥ 22.19, **zero runtime dependencies**
  (`fetch` and global `WebSocket` are Node built-ins). `tsc` builds `dist/`; `prepare` runs the
  build so `npm link` produces working bins.
- **Repo:** `~/CodeBase/dsh-bridge`, independent git repository. Not inside the DSH source tree.

## 3. Wire facts (verified against a live host, 0.2.1-rc.2 desktop, port 49904)

Version note: the **running** desktop app is `0.2.1-rc.2`. The DSH source checkout on this machine
is `0.1.5-rc.2`, which is *not* the serving build — do not take code there as what the host does.
Where the two differ in a way that matters for this tool, §3.5 says so.

These are the ground truth the client is built on. Re-verify with `ping`/`sessions` if a DSH
upgrade breaks the client.

### 3.1 Authentication (self-minted browser cookie)

All `/api` traffic runs on a trusted-authority path with a **loopback host check** and a
**signed browser cookie**. The client mints that cookie itself; no launch token is needed.

- Secret: `$DSH_HOME/.credentials.yaml` → top-level key `client-connection/browser-session` →
  `payload.secret`, a base64url-encoded 32-byte value.
- `authority` = `host:port` exactly as the client addresses it (e.g. `127.0.0.1:49904`).
- Cookie **name** = `dsh-auth-` + base64url(sha256(authority)).
- Cookie **value** = `v1.` + body + `.` + base64url(HMAC-SHA256(secretBytes, body)),
  where `body` = base64url(utf8(JSON of `{version: 1, authority, issuedAt, expiresAt}`)),
  and the two timestamps are **milliseconds**.
- Send it as a plain `Cookie` header on both HTTP and the WebSocket upgrade.
- base64url = standard base64 with `+`→`-`, `/`→`_`, `=` stripped.

Failure modes to report clearly: credentials file missing, record missing, secret not 32 bytes,
HTTP 401 (secret rotated since DSH started → restart DSH), HTTP 403 (authority mismatch).

### 3.2 Unary calls

`POST /api/<endpoint>` with header `content-type: application/json` and the cookie.

```json
{"type":"client-request","rpcId":"<any unique local id>","method":"<endpoint>","payload":{"args":{...}}}
```

Response `{"type":"server-response","rpcId":"...","result":{"ok":true,"value":...}}`.

Failures appear in two shapes and the client must accept both, reporting the real code:
host 0.2.x nests them as `result.error = {code, message, details}`, host 0.1.5 nests them as
`result.ok === false` with the same object. HTTP 401/403/404 can occur before the envelope and
must be surfaced with their status. (T1 correction, verified against both hosts.)

The `payload.args` object is keyed by **Host parameter name**:

| Endpoint | args |
|---|---|
| `session/list` | `{"_request":{}}` |
| `session/page` | `{"request":{"address":{"kind":"session","sessionId":"<id>"},"throughSeq":<int>,"maxMessages":<int>}}` |
| `session/prompt` | `{"request":{"requestId":"<uuid>","sessionId":"<id>","mode":"queue"\|"steer","content":[{"type":"text","text":"..."}]}}` |

`session/page` rejects `throughSeq` greater than the current cursor (`gateway/bad-request`,
`... is past cursor N`); the current cursor comes from the follow stream's opening snapshot.

### 3.3 `session/list` rows (used for resolution)

Each item: `sessionId`, `updatedAt` (ms), `running` (bool), `agentAvailable`, `blank`, `cwd`,
`projections.values.title`, `projections.values.turnOutline`, token usage, model selection.
Treat every field as optional except `sessionId`.

### 3.4 Stream carrier (`session/follow`)

1. Open `ws://<authority>/api/remote.mux` with the `Cookie` header.
2. Send `{"type":"open","streamId":"<local id>","endpoint":"session/follow","payload":{"args":{"request":{"address":{"kind":"session","sessionId":"<id>"}}}}}`
3. Frames: `{"streamId":"<local id>","type":"item"|"end"|"error","value":...}`.
   Ignore frames whose `streamId` is not ours.
   `value` is `{"type":"snapshot", "cursor":<int>, "records":[...], ...}`, or a durable event
   entry `{"type":"event","event":{"type","seq","time","data"}}`, or
   `{"type":"assistant-stream", ...}`. **Ignore assistant-stream frames** (v1 returns only
   settled text).
4. `type:"end"` / `type:"error"` terminate the stream.

### 3.5 Durable event shapes used by the client

| event | fields |
|---|---|
| `turn/start` | `data.turn` |
| `user/message` | `data.source = {kind:"user", rpcId, clientTimeZone}`, `data.content[]` |
| `assistant/message` | `data.turn`, `data.message.content[{type:"reasoning"\|"text"\|"tool-call"}]`, `data.usage` |
| `tool/call` | `data.{turn, step, callId, name, arguments}` |
| `tool/result` | `data.{turn, step, message, error?}` — the call id appears in **two shapes**, see below |
| `turn/end` | `data.{turn, reason:{kind}}` |

`tool/result` message shapes (both are real; the client must accept both):
0.2.x carries `data.message.toolCallId` at the top level, plus
`data.message.content[0] = {type:"tool-result", toolCallId, …}`. 0.1.x carries **no** top-level id —
the call id lives in `data.message.source.callId` (`{kind:"tool"}`) and in
`data.message.content[0].toolCallId`. Linking a call to its result must therefore try all four
fields; missing this makes every `toolCalls[].ok` read `false` on 0.1.x logs (review finding P1-3).

`turn/end` reason kinds seen in the source: `completed`, `aborted` (+ reason), `blocked`,
`error` (+ structured error), `max-tokens`, and plugin-extensible variants.

## 4. Addressing

Exactly one selector family must be given; filters AND together.

| flag | meaning |
|---|---|
| `--session <id>` | exact id, or a unique prefix; `session-` prefix on both sides is ignored when comparing |
| `--title <substr>` | case-insensitive substring of `projections.values.title` |
| `--cwd <path>` | exact match after `realpath`-style normalization |
| `--latest` | take the newest `updatedAt` among the filtered rows |

- No selector → error (never guess).
- More than one match after applying `--latest` → error listing up to 10 candidates
  (`sessionId`, title, cwd, updatedAt) so the caller can disambiguate.
- `--latest` without other filters is allowed.

## 5. `send` semantics

1. Resolve target; reject if `agentAvailable === false` unless `--force`.
2. Open the follow stream and record its opening `cursor` as the baseline **before** prompting.
3. `session/prompt` with a fresh `requestId` (uuid v4), `mode` = `queue` (default) or `steer`
   (`--steer`), content = one text part: `[via <from>] <text>` unless `--no-prefix`.
4. Record `{rpcId, sessionId, from, createdAt}` into the local index **immediately** on
   acceptance (`$DSH_HOME/dsh-bridge/sends.jsonl`, append-only, best-effort) so `result` works
   even if this process dies.
5. Wait for: the `user/message` whose `source.rpcId` equals our `requestId`; the turn it lands
   in (the most recent `turn/start` at or before it); then the `turn/end` for that same turn.
   This is the only completion signal — no polling for quiescence, no guessing.
6. Render the result (section 6) and exit.

- Default timeout: **180 s** (`--timeout <seconds>`, also `DSH_BRIDGE_TIMEOUT`), chosen so the
  caller returns long before typical harness bash-tool ceilings.
- On timeout: print the result with `status: "timeout"`, include the `rpcId` and any settled
  assistant text from the turn so far, plus a one-line hint to stderr telling the caller how to
  finish reading it later. Exit code 2.
- `--detach`: after prompt acceptance, print `rpcId` (plain) or the JSON with
  `status: "pending"`, and exit 0 immediately.
- Busy target: `queue` is the default and is not an error. The default timeout may then elapse
  while the target is still working on an earlier turn; that must surface as `timeout`, not as a
  silent wrong answer (see 6: text is collected only from our own turn).

## 6. Result contract

Plain stdout (no `--json`) prints **only the final assistant text of our turn** — the
concatenation, in order, of `text` blocks of the `assistant/message` events belonging to our
turn, joined with a single blank line. No prefixes, no headers, no ANSI. Exit 0.

`--json` prints one JSON object:

```json
{
  "rpcId": "…",
  "sessionId": "…",
  "from": "claude-code",
  "turn": 7,
  "status": "completed | error | cancelled | timeout | pending",
  "reason": { "kind": "completed" },
  "text": "…",
  "toolCalls": [{ "name": "bash", "ok": true }],
  "durationMs": 12345,
  "usage": { "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0 },
  "host": "http://127.0.0.1:49904"
}
```

`text` is empty while `status` is `pending` (an unfinished turn has no final answer, so a plain-mode
caller must never see text with exit 0). Whatever settled so far on a pending turn appears only in
`--json` as an optional `partialText` field. `timeout` still carries the settled `text`, because a
timed-out turn keeps making progress and the caller may want what exists.

Status mapping from `turn/end.reason.kind`: `completed` → `completed`; `max-tokens` →
`completed`; `aborted` → `cancelled`; `blocked` / `error` / unknown → `error`.
`reason` always carries the raw kind so nothing is lost.

`toolCalls[].ok` = `false` when the matching `tool/result` carries `data.error` or no result
arrived before `turn/end`; `true` otherwise. Include only calls of our turn, in call order.

`usage` = sum of `data.usage` across the turn's `assistant/message` events (missing fields → 0).

### Exit codes

| code | meaning |
|---|---|
| 0 | turn completed (`completed`, incl. `max-tokens`) or `--detach` accepted |
| 2 | `status: "timeout"` |
| 3 | turn ended in `error` / `cancelled` |
| 1 | local error: bad args, no resolution, auth failure, host unreachable, protocol error |

## 7. `result --rpc-id <id>`

Reads back a previously sent message's outcome without sending anything new.

1. Look up the rpcId in the local index to find the session. If absent, scan the 50 most
   recently updated sessions, reading their tail pages, for a `user/message` with that
   `source.rpcId` (bounded: at most 50 sessions × 2 pages).
2. Reconstruct from the session log: the message's turn, its `assistant/message` texts, its
   `tool/call`s, and its `turn/end` if present.
3. If `turn/end` is absent → `status: "pending"` (still running), exit 0.
4. Otherwise same rendering and exit codes as `send`.

`result --wait` (optional, same `--timeout`) waits for the missing `turn/end` via `session/follow`
from the reconstructed point instead of returning `pending`.

## 8. `sessions`

Lists/filters rows for target discovery (`--session/--title/--cwd/--latest`, `--limit`, `--json`).
Plain output: one line per row, `<sessionId>\t<running?>\t<updatedAt ISO>\t<title>\t<cwd>`.
Truncate nothing; let the caller pipe. Also serves as the connectivity/auth self-check.

## 9. Host discovery

Order: `--host <url>` → `DSH_BRIDGE_HOST` → auto-detect.

Auto-detect: enumerate loopback listening sockets owned by the current user (macOS `lsof`),
keep candidates whose owning process command line mentions `DeepSeek Harness` or `dsh`, then
confirm a candidate by a cookie-authenticated `session/list`. First confirmed wins. On failure
print a hint to pass `--host http://127.0.0.1:<port>`.

`--dsh-home <path>` overrides `$DSH_HOME` (default `~/.dsh`) for credentials and the send index.

## 10. MCP server (`dsh-bridge-mcp`)

Newline-delimited JSON-RPC 2.0 over stdio (MCP stdio transport, protocol version `2024-11-05`).

Tools:

| tool | input | behaviour |
|---|---|---|
| `dsh_send` | `{target?:{session?,title?,cwd?,latest?}, text, from?, timeoutSeconds?, detach?, prefix?}` | `send`; returns the `--json` object as `structuredContent` plus a text block containing `text` |
| `dsh_result` | `{rpcId, wait?, timeoutSeconds?}` | `result`; same return shape |
| `dsh_sessions` | `{session?,title?,cwd?,latest?,limit?}` | `sessions`; returns the rows as text + `structuredContent` |

Requirements: `initialize` echoes the client's protocol version when acceptable and advertises
`tools` capability; `tools/list` returns JSON Schemas for the three tools; `tools/call` returns
`{content:[{type:"text",text}], structuredContent, isError?}`; unknown method → JSON-RPC error
`-32601`; tool failures → `isError: true` with a human-readable message rather than a transport
error. Server name `dsh-bridge`, version from `package.json`. Default timeout for MCP calls:
3600 s. `from` defaults to `$DSH_BRIDGE_FROM` or `mcp`.

## 11. Non-negotiables for implementers

- Never write into the DSH source checkout or `~/.dsh` beyond the append-only
  `dsh-bridge/sends.jsonl` index and reads of `.credentials.yaml`.
- Never send to a real user session during tests. All `send` tests target a **staging instance**:
  a spawned `dsh web --port 0` with `DSH_HOME` and `DSH_AGENTS_HOME` in a temp dir and
  `DEEPSEEK_BASE_URL` pointed at a local stub provider that speaks the OpenAI-completions wire
  format. Real hosts are used for read-only checks only (`sessions`, resolution, `follow`).
- Zero runtime dependencies. Dev dependencies: `typescript`, `@types/node`.
- No silent fallbacks on protocol mismatches: fail with the endpoint, status, and envelope.
