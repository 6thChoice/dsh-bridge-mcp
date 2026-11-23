# T2 — MCP stdio shell

Implements §10 of [`../spec.md`](../spec.md) on top of T1's core module.

## Deliverables

- `src/mcp.ts` — newline-delimited JSON-RPC 2.0 over stdio. Handles `initialize`, `ping`,
  `tools/list`, `tools/call`; ignores notifications (`notifications/initialized`);
  unknown method → `-32601`; tool-level failures → `isError: true` result, never a transport error.
- Bin `dsh-bridge-mcp` wired in `package.json` → `dist/mcp.js`.
- Three tools with exact JSON Schemas: `dsh_send`, `dsh_result`, `dsh_sessions` (fields per §10).
- `tests/mcp.test.ts` — spawn the bin, drive it over stdio: initialize handshake, tools/list
  schemas, one `dsh_sessions` call against the live host (read-only), one `dsh_send` against the
  staging instance, an unknown-method error, and a tool failure (`isError`).

## Acceptance criteria

1. `initialize` returns server info `{name:"dsh-bridge", version:<package version>}` and
   `capabilities.tools`.
2. `tools/list` returns exactly three tools with valid JSON Schemas; no extra tools.
3. `dsh_send` against the staging instance returns `content[0].text` equal to the stub's assistant
   text, `structuredContent.status === "completed"`, `isError` absent.
4. `dsh_send` with a bogus target returns `isError: true` and a message naming the ambiguity/failure,
   exit stays 0 (the server keeps serving).
5. `dsh_result` for a detached send works; `dsh_sessions` returns rows.
6. Protocol is line-delimited, no stdout pollution (all diagnostics on stderr);
   `node dist/mcp.js < /dev/null` exits 0 without hanging.
7. `npm run typecheck` clean, all tests green.

## Notes

- Reuse T1's core verbatim; do not duplicate auth/resolve/await logic.
- MCP default `timeoutSeconds` is 3600 unless the caller passes one.
- `from` defaults to `$DSH_BRIDGE_FROM` or `mcp`.

## Result

**Status:** complete on `main`. Three commits: the server, its tests, and this evidence.

### What exists

- `src/mcp.ts` — the whole MCP shell, 670 lines with comments and schemas. Newline-delimited
  JSON-RPC 2.0 on stdin/stdout; methods `initialize`, `ping`, `tools/list`, `tools/call`;
  notifications are read and ignored (never answered); unknown method → `-32601`. Framing
  problems → `-32700` / `-32600` / `-32602`; everything that happens while a tool runs → a
  `tools/call` result with `isError: true`. The shell adds no DSH logic: `dsh_send` calls
  `sendMessage` from `src/run.ts`, `dsh_result` calls `resultMessage` from `src/result.ts`,
  `dsh_sessions` calls `SessionClient.listSessions` + `filterSessions`. Host discovery, cookie
  minting, resolution and the wait-for-own-turn engine are T1's, untouched.
- `tests/mcp.test.ts` — 12 tests: 4 protocol unit tests against `handleRequest` (no host, no
  network), the stdin-EOF exit, a handshake over real stdio, a read-only `dsh_sessions` against
  the live desktop host, and six staging tests (`dsh web --port 0` + stub provider, temp
  `DSH_HOME`): blocking send, `$DSH_BRIDGE_FROM` default, detach + `dsh_result --wait`, timeout +
  read-back, bogus target + still-serving, and the `dsh_result` read-back inside the first test.
- `package.json` — `"dsh-bridge-mcp": "dist/mcp.js"` in `bin`; `scripts/postbuild.mjs` (T1) already
  chmods it, so `npm link` yields a runnable command.

### Decisions (closed questions the spec left to the implementer)

1. **`isError` mirrors the CLI exit code.** Absent for `completed`/`pending` (exit 0), `true` for
   `timeout` (2) and `error`/`cancelled` (3), and for every thrown `BridgeError` / bad argument. A
   client that never reads `structuredContent` therefore cannot mistake a failed turn for a
   success. The text block follows §6's plain contract: the turn's assistant text, the `rpcId`
   while the turn is pending (that is what §6's plain detach output is), otherwise the status line
   (or the timeout hint). Exactly one content block, always.
2. **`structuredContent` for `dsh_sessions` is `{sessions: [...]}`** holding the raw `session/list`
   rows — the same rows `dsh-bridge sessions --json` prints — and the text block is the §8 plain
   row format (`sessionId\trunning\tupdatedAt\ttitle\tcwd`). Raw rows are verbose (they include
   `projections`), so the tool description tells callers to pass a small `limit`.
3. **Malformed params**: for `tools/call` a bad argument (wrong type, empty text, missing target,
   unknown field value) is a **tool-level `isError` result**; the protocol-level errors are reserved
   for framing (`-32700` non-JSON line, `-32600` not an object / wrong `jsonrpc` / batch, `-32602`
   `name`/`arguments` shape or unknown tool name, `-32601` unknown method). Unknown fields inside
   `arguments`/`target` are ignored rather than rejected, and an explicit `null` means "absent", so
   lenient clients do not trip on optional fields.
4. **No host/home switches in the tool surface** (spec §10 closes it): the host comes from
   `DSH_BRIDGE_HOST` then loopback discovery, the DSH home from `DSH_HOME` (default `~/.dsh`).
   `mode` is always `queue` and there is no `force`, so a session with `agentAvailable: false` is a
   hard tool error — its message still says "pass --force to send anyway" because that string is
   the shared core's (T2 must not rewrite core messages).
5. **`DSH_BRIDGE_TIMEOUT` is not honoured by MCP.** §10 fixes the MCP default at 3600 s; only the
   per-call `timeoutSeconds` overrides it. (The CLI keeps its own 180 s / `DSH_BRIDGE_TIMEOUT`
   behaviour.) T3's docs must say this.
6. **One fresh `SessionClient` per tool call** — credentials are re-read and discovery re-runs, so
   a restarted DSH host is picked up without restarting the MCP server. The send index is the same
   `$DSH_HOME/dsh-bridge/sends.jsonl` the CLI writes, so a send detached through MCP is readable
   through the CLI and vice versa.
7. **stdin EOF**: the server waits for in-flight requests to settle (a client that closed stdin may
   still be reading), then exits 0; with nothing in flight it exits immediately. Nothing else keeps
   the process alive (all follow streams are closed on every path in `awaitTurn`).
8. stdout carries protocol frames only. Every diagnostic (discovery notes, timeout hints, core
   failure messages, unexpected stacks) goes to stderr.

### Verification

**1. Typecheck** (strict, `src` + `tests`):

```console
$ npm run typecheck
> dsh-bridge@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit
$ echo $?
0
```

**2. Full suite — T1's 41 plus the 12 new MCP tests:**

```console
$ npm test
…
✔ initialize advertises the three-tool server and echoes a supported version (821.534917ms)
✔ tools/list returns exactly the three spec tools with their input schemas (0.214792ms)
✔ unknown method is -32601 and notifications get no response (0.090125ms)
✔ bad tool input is an isError result, never a transport error (0.322291ms)
✔ the built bin exits 0 on stdin EOF without hanging (32.224541ms)
✔ initialize handshake, tools/list and an unknown method over real stdio (30.427542ms)
✔ dsh_sessions lists rows from the live host (read-only) (999.539542ms)
✔ dsh_send completes against staging: text is the stub reply, status completed (140.484041ms)
✔ from defaults to $DSH_BRIDGE_FROM when the call omits it (98.267208ms)
✔ detach returns the rpcId as text; dsh_result --wait finishes the turn (1591.828ms)
✔ a timed-out send is isError with status timeout and stays readable (3107.599833ms)
✔ a bogus target is isError and the server keeps serving (105.351625ms)
…
ℹ tests 53
ℹ suites 0
ℹ pass 53
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 34097.452542
```

The live-host test skips itself (instead of failing) on a machine with no reachable DSH; here it
ran. Every `send` in the suite targets the staging instance; no real session is prompted.

**3. `initialize` + `tools/list` over the real bin** — stdout verbatim, one JSON-RPC line each
(3,979 bytes total, wrapped by the terminal only):

```console
$ printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"evidence","version":"1.0.0"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node dist/mcp.js; echo "exit=$?"
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"dsh-bridge","version":"0.1.0"},"instructions":"dsh-bridge hands one message to an existing DeepSeek Harness session. Use dsh_sessions to find a session id, dsh_send to prompt it (waiting for its own turn), dsh_result to read a detached send back. Host and DSH home come from DSH_BRIDGE_HOST / DSH_HOME."}}
{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"dsh_send","description":"Send one message to an existing DeepSeek Harness session and wait for that message's own turn to end. Returns the turn's final assistant text, plus the full result object as structuredContent (rpcId, sessionId, status, reason, toolCalls, usage, host). Use detach=true to return immediately with status \"pending\", then dsh_result to read it back. This is the only tool that prompts a session.","inputSchema":{"type":"object","properties":{"target":{"type":"object","description":"Which existing session to address. Filters AND together; everything absent means no filter, which is rejected by dsh_send (never guess a target).","properties":{"session":{"type":"string","description":"Exact session id or a unique prefix; a leading \"session-\" is ignored."},"title":{"type":"string","description":"Case-insensitive substring of the session title."},"cwd":{"type":"string","description":"Exact working directory of the session (realpath-normalized)."},"latest":{"type":"boolean","description":"Take the newest updatedAt among the rows matching the other filters."}},"additionalProperties":false},"text":{"type":"string","description":"The message to send (plain text)."},"from":{"type":"string","description":"Label put in the \"[via <from>] \" prefix and recorded in the send index; defaults to the DSH_BRIDGE_FROM environment variable or \"mcp\"."},"timeoutSeconds":{"type":"number","description":"How long to wait for the turn to end before returning status \"timeout\"; default 3600."},"detach":{"type":"boolean","description":"Return as soon as the prompt is accepted (status \"pending\", text is the rpcId) instead of waiting for the turn to end. Default false."},"prefix":{"type":"boolean","description":"Prepend \"[via <from>] \" to the text. Default true; set false to send the text verbatim."}},"required":["text"],"additionalProperties":false}},{"name":"dsh_result","description":"Read back the outcome of a message previously accepted by dsh_send, without sending anything new. Returns the same object shape as dsh_send. Use wait=true to block until the turn ends instead of returning status \"pending\".","inputSchema":{"type":"object","properties":{"rpcId":{"type":"string","description":"The rpcId returned by dsh_send (structuredContent.rpcId)."},"wait":{"type":"boolean","description":"Wait for the turn to end instead of returning status \"pending\" immediately. Default false."},"timeoutSeconds":{"type":"number","description":"How long wait=true may block before returning status \"timeout\"; default 3600."}},"required":["rpcId"],"additionalProperties":false}},{"name":"dsh_sessions","description":"List DeepSeek Harness sessions (read-only; also the connectivity/auth self-check). Use it to discover a session id for dsh_send. Filters AND together; no filter lists everything. Each row is the raw session/list record and therefore verbose, so pass a small limit.","inputSchema":{"type":"object","properties":{"session":{"type":"string","description":"Exact session id or a unique prefix; a leading \"session-\" is ignored."},"title":{"type":"string","description":"Case-insensitive substring of the session title."},"cwd":{"type":"string","description":"Exact working directory of the session (realpath-normalized)."},"latest":{"type":"boolean","description":"Keep only the newest updatedAt among the rows matching the other filters."},"limit":{"type":"integer","description":"Return at most this many rows (newest first)."}},"additionalProperties":false}}]}}
exit=0
```

The notification produced no line (protocol silence); exit 0. `protocolVersion` echoed the client's
`2025-03-26` because it is in the supported set; any other value answers `2024-11-05`
(asserted by the unit tests).

**4. `dsh_sessions` against the live desktop host, read-only** — the raw stdout line for two rows
was 4,319 bytes when captured (`structuredContent.sessions` carries the full rows, whose
`projections` keep growing as the sessions work, so a rerun prints a slightly different size), so
the pipeline below prints the text block and a row summary of exactly the line the server wrote.
Nothing was edited:

```console
$ printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"dsh_sessions","arguments":{"limit":2}}}' \
  | DSH_BRIDGE_HOST=http://127.0.0.1:49904 DSH_HOME="$HOME/.dsh" node dist/mcp.js > /tmp/sessions.jsonl; echo "exit=$?"
exit=0
$ wc -c < /tmp/sessions.jsonl
    4319
$ node -e '
const lines = require("node:fs").readFileSync("/tmp/sessions.jsonl", "utf8").trim().split("\n");
for (const line of lines) {
  const message = JSON.parse(line);
  const result = message.result;
  console.log(`id=${message.id} isError=${String(result.isError === true)}`);
  console.log("content[0].text (tabs shown as " + " ⇥ " + "):");
  console.log(result.content[0].text.replace(/\t/g, " ⇥ "));
  const rows = result.structuredContent.sessions;
  console.log(`structuredContent.sessions: ${String(rows.length)} rows; first = ${rows[0].sessionId} | running=${String(rows[0].running)} | title=${JSON.stringify(rows[0].projections.values.title)} | cwd=${String(rows[0].cwd)}`);
}' 
id=1 isError=false
content[0].text (tabs shown as  ⇥ ):
5e9fdd65-0cc7-4038-b57d-66af877d3c67 ⇥ true ⇥ 2026-11-23T08:46:35.506Z ⇥ You are implementing ticket T2 ⇥ /Users/zhouxuancheng/Documents/Agent/deepseek-harness
f192cdb2-f1a8-44c7-96f5-d4df24fb584b ⇥ false ⇥ 2026-11-23T08:21:16.263Z ⇥ You are implementing ticket T1 ⇥ /Users/zhouxuancheng/Documents/Agent/deepseek-harness
structuredContent.sessions: 2 rows; first = 5e9fdd65-0cc7-4038-b57d-66af877d3c67 | running=true | title="You are implementing ticket T2" | cwd=/Users/zhouxuancheng/Documents/Agent/deepseek-harness
```

With `DSH_BRIDGE_HOST`/`DSH_HOME` unset the same call succeeds through auto-discovery (the live
test in `tests/mcp.test.ts` does exactly that).

**5. `dsh_send` against the staging instance, then read-back, failure, and recovery.** The driver
below spawns T1's staging harness (`dist-test/tests/staging.js`, packaged `dsh web --port 0` + local
stub provider), then drives `dist/mcp.js` over stdio and echoes the server's stdout **verbatim**;
its own notes (staging host, exit code, the server's stderr) went to stderr. The driver was a
throwaway file outside the repo — its committed equivalent is `tests/mcp.test.ts`, which asserts
every line of this transcript:

```console
$ node /tmp/t2-evidence/send-staging.mjs
# staging host http://127.0.0.1:49408
# staging session session-20a25105-b935-47f3-8568-3cbaceb3e303
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"dsh-bridge","version":"0.1.0"},"instructions":"dsh-bridge hands one message to an existing DeepSeek Harness session. Use dsh_sessions to find a session id, dsh_send to prompt it (waiting for its own turn), dsh_result to read a detached send back. Host and DSH home come from DSH_BRIDGE_HOST / DSH_HOME."}}
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"MCP-EVIDENCE-PONG"}],"structuredContent":{"rpcId":"a6afccf6-a0b9-410b-bc95-d3dbdae0611a","sessionId":"session-20a25105-b935-47f3-8568-3cbaceb3e303","from":"mcp","turn":1,"status":"completed","reason":{"kind":"completed"},"text":"MCP-EVIDENCE-PONG","toolCalls":[],"durationMs":100,"usage":{"inputTokens":10,"outputTokens":2,"cacheReadTokens":0},"host":"http://127.0.0.1:49408"}}}
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"MCP-EVIDENCE-PONG"}],"structuredContent":{"rpcId":"a6afccf6-a0b9-410b-bc95-d3dbdae0611a","sessionId":"session-20a25105-b935-47f3-8568-3cbaceb3e303","from":"mcp","turn":1,"status":"completed","reason":{"kind":"completed"},"text":"MCP-EVIDENCE-PONG","toolCalls":[],"durationMs":53,"usage":{"inputTokens":10,"outputTokens":2,"cacheReadTokens":0},"host":"http://127.0.0.1:49408"}}}
{"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"dsh_send: target --session no-such-session-anywhere matched no sessions; run `dsh-bridge sessions` to list them"}],"isError":true}}
{"jsonrpc":"2.0","id":5,"result":{"content":[{"type":"text","text":""}],"structuredContent":{"sessions":[]}}}
{"jsonrpc":"2.0","id":6,"error":{"code":-32601,"message":"unknown method \"this/method/does/not/exist\"; supported: initialize, ping, tools/list, tools/call"}}
# mcp exit code: 0
# server stderr:
dsh-bridge-mcp: dsh_send failed: target --session no-such-session-anywhere matched no sessions; run `dsh-bridge sessions` to list them
```

Reading the transcript: id 2 is `dsh_send` — `content[0].text` is exactly the stub's reply
(`MCP-EVIDENCE-PONG`), `structuredContent.status === "completed"`, no `isError`, `from` defaulted to
`mcp`, and the stub received `[via mcp] mcp-evidence`. id 3 is `dsh_result` on the same rpcId. id 4
is the bogus target: `isError: true`, exit stays 0. id 5 hits the host again after the failure
(`session/list`, zero rows for a title filter that matches nothing), proving the server kept
serving. id 6 is the unknown method.

**6. EOF and the bin wiring:**

```console
$ node dist/mcp.js < /dev/null; echo "exit=$?"
exit=0
$ node -e 'console.log(JSON.stringify(require("./package.json").bin))'
{"dsh-bridge":"dist/cli.js","dsh-bridge-mcp":"dist/mcp.js"}
$ ls -l dist/mcp.js | awk '{print $1, $NF}'
-rwxr-xr-x@ dist/mcp.js
$ ln -sf "$PWD/dist/mcp.js" /tmp/bin/dsh-bridge-mcp && echo '{"jsonrpc":"2.0","id":1,"method":"ping"}' | /tmp/bin/dsh-bridge-mcp
{"jsonrpc":"2.0","id":1,"result":{}}
$ /tmp/bin/dsh-bridge-mcp < /dev/null; echo "exit=$?"
exit=0
```

The symlink case is the `npm link` shape (`process.argv[1]` is the link, not the file), so T3's
`npm link` will produce a working `dsh-bridge-mcp`.

### Notes for T3

- **Launch line:** `dsh-bridge-mcp` (after `npm link`), or
  `node /Users/zhouxuancheng/CodeBase/dsh-bridge/dist/mcp.js`. No arguments; it speaks MCP stdio
  and exits 0 when its stdin closes.
- **Environment it honours:** `DSH_BRIDGE_HOST` (pin the host, e.g. `http://127.0.0.1:49904`;
  otherwise macOS loopback discovery), `DSH_HOME` (credentials + send index; default `~/.dsh`),
  `DSH_BRIDGE_FROM` (default `from`, else `mcp`). It does **not** read `DSH_BRIDGE_TIMEOUT`; the
  MCP default is 3600 s and only the per-call `timeoutSeconds` changes it. A config that needs a
  specific host looks like
  `{"mcpServers":{"dsh-bridge":{"command":"dsh-bridge-mcp","env":{"DSH_BRIDGE_HOST":"http://127.0.0.1:49904"}}}}`.
- **Tool surface for `docs/usage.md`:** `dsh_send {target:{session?|title?|cwd?|latest?}, text,
  from?, timeoutSeconds?, detach?, prefix?}`, `dsh_result {rpcId, wait?, timeoutSeconds?}`,
  `dsh_sessions {session?, title?, cwd?, latest?, limit?}`. Results: `content[0].text` is the
  assistant text (or the rpcId when pending, or the status/hint when `isError`), and
  `structuredContent` is exactly the §6 object, so `structuredContent.status` is the machine verdict.
- MCP has no `--host`, `--dsh-home`, `--steer`, `--force`, or `--limit` flags; document the env
  vars instead, and note that a session with `agentAvailable: false` is a hard error over MCP.
