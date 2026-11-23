# T1 — Core client + CLI (`sessions`, `send`, `result`)

Implements §2–§9 of [`../spec.md`](../protocol.md). This ticket is the whole kernel: auth, discovery,
resolution, prompt/await, result rendering, plus the staging harness that proves it.

## Deliverables

- Repo scaffolding: `package.json` (name `dsh-bridge`, `type: module`, bins `dsh-bridge`,
  `dsh-bridge-mcp` reserved for T2, `prepare` = build, engines `node >= 22.19`),
  `tsconfig.json` (strict, `module: nodenext`, `target: es2023`, `outDir dist`, `rootDir src`),
  `.gitignore` (`node_modules`, `dist`, `*.log`), `README.md` (what/why/quickstart, one screen).
- `src/auth.ts` — credential read, cookie minting (§3.1).
- `src/host.ts` — host resolution + discovery (§9), unary RPC helper (§3.2) with explicit errors.
- `src/client.ts` — `listSessions`, `followSession` (WS carrier, §3.4), typed event accessors.
- `src/resolve.ts` — target resolution (§4).
- `src/run.ts` — the await engine (§5) and result rendering (§6).
- `src/result.ts` — read-back path (§7), send index (§5 step 4).
- `src/cli.ts` — argument parsing (no dependency, hand-rolled or `node:util` parseArgs), exit codes.
- `tests/` — unit tests for auth, resolve, status mapping, rendering; `tests/staging.ts` helper
  that spawns the staging instance (§11) with a stub OpenAI-completions provider; integration
  tests for `send` blocking, `send --detach` + `result`, and the timeout path.

## Acceptance criteria

1. `node dist/cli.js sessions --json` against the live desktop host lists sessions; plain output is
   one line per row in the §8 shape.
2. Resolution: exact id, unique prefix, title substring, cwd, `--latest` all work; ambiguity error
   lists candidates; no selector errors out.
3. Staging integration test: `send --session <staging> "ping"` returns exactly the stub's assistant
   text on stdout, exit 0; the stub received a user message whose text starts with
   `[via <from>] `; the session log contains our `rpcId`.
4. `send --detach` prints an rpcId and exits 0 before the turn ends; `result --rpc-id` then returns
   the verdict (pending immediately after, completed after).
5. Timeout path: with `--timeout 1` against a stub that delays, exit 2, `status: "timeout"`,
   `rpcId` present, stderr hint present.
6. `queue` semantics honoured: with a turn already running in the staging session, a queued send
   waits for its own turn and returns that turn's text, never the earlier turn's.
7. `toolCalls` and `usage` populated correctly on a turn that calls a tool (stub can emit one
   tool call; the tool may be any real read-only tool such as `bash echo`).
8. `npm run typecheck` (tsc `--noEmit`) clean; unit + staging tests green via `npm test`.
9. README quickstart actually runs verbatim on this machine.

## Notes

- Staging instance: pick a runnable `dsh`. The packaged app runtime CLI works:
  `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh web --no-open --port 0`
  (reports `dsh web: http://127.0.0.1:<port>/?token=...`). The packaged CLI and the live desktop
  app are both **0.2.1-rc.2**; the 0.1.5-rc.2 tree on this machine is only the DSH source checkout,
  not a serving build. If the wire disappears on a later version, report it instead of guessing.
- The staging instance's own cookie secret is minted on first Connection activation into its
  temp `DSH_HOME`; wait for readiness before reading it.
- Keep `send` from prompting a staging session that has no configured provider: pass
  `DEEPSEEK_API_KEY=dummy` + `DEEPSEEK_BASE_URL=http://127.0.0.1:<stub-port>` and `--no-open`.

## Result

Implemented 2026-11-23 by the T1 session (branch `main`).

### What exists

- `src/auth.ts` — `.credentials.yaml` reader (minimal block-YAML subset, fail-loud on missing
  record / bad base64url / non-32-byte secret) and cookie minting per spec §3.1.
- `src/host.ts` — origin parsing, `RpcTransport` (one envelope per call, explicit HTTP 401/403/404
  and envelope/protocol errors), `--host` → `DSH_BRIDGE_HOST` → macOS `lsof` loopback discovery
  confirmed with `session/list`.
- `src/client.ts` — `SessionClient` (`listSessions`, `pageSession`, `prompt`, `followSession`,
  generic `rpc`) plus `FollowStream`, which keeps the opening snapshot/cursor and exposes durable
  events only (assistant-stream frames dropped).
- `src/resolve.ts` — exact/prefix/title/cwd/`--latest` resolution, `session-` prefix agnostic,
  candidate list capped at 10, no-selector error.
- `src/run.ts` — `sendMessage` (follow-before-prompt baseline, queue/steer, inbox-record before
  awaiting, own-turn matching, timeout, detach) and rendering helpers (`renderAssistantText`,
  `sumUsage`, `collectToolCalls`, `reconstructTurn`, status mapping, exit codes).
- `src/result.ts` — `SendIndex` (`$DSH_HOME/dsh-bridge/sends.jsonl`, best-effort append) and
  `resultMessage` (index first, then 50 sessions × 2 tail pages; page-back reconstruction;
  `--wait`).
- `src/cli.ts` — `sessions|send|result`, hand-rolled via `node:util` `parseArgs`; plain stdout is
  text only, `--json` one object; diagnostics on stderr; spec exit codes.
- `src/errors.ts`, `src/runtime.ts`, `scripts/postbuild.mjs` — shared error taxonomy, Node
  >=22.19 guard, executable-bit fix for `npm link` bins (extra modules beyond the ticket list).
- `tests/` — 33 unit tests (auth, host/envelope, resolution, rendering/status/tool/usage,
  runtime floor) and 8 staging integration tests (blocking, no-prefix, detach+result+wait,
  timeout, queue-after-running-turn, toolCalls/usage via a real bash tool, index-less scan,
  sessions/unknown rpcId). `tests/staging.ts` spawns the packaged `dsh web` with a temp
  `DSH_HOME`, a stub model endpoint, and never touches a real session.

### Deviations from the spec/ticket, with reasons

1. **Stub wire format.** The ticket says the staging stub must speak OpenAI-completions. The
   packaged 0.2.1-rc.2 `deepseek-official` route actually calls **Anthropic Messages**
   (`POST /v1/messages`) against `DEEPSEEK_BASE_URL`; that is what the staging instance uses.
   The stub therefore speaks both formats (`/v1/messages` and `/chat/completions`), selected by
   path; tests exercise the Anthropic route. Reason: verified against the live staging process,
   not assumed.
2. **RPC error envelope.** The live 0.2.1-rc.2 desktop nests errors as
   `result.error.{code,message,details}`; spec §3.2 shows them directly on `result`. The client
   accepts both and always reports the real code/message (verified with
   `session/agent-busy` from `session/page` on subagent sessions). **Review correction:** that
   check ran on 0.2.1-rc.2 twice (desktop + the staged packaged CLI), not on two host versions;
   the 0.1.5-rc.2 tree is the source checkout only, never the serving build.
3. **Read-back reconstruction.** A follow opening snapshot is capped and reports `hasMore`
   (live example below: cursor 654, 361 records). `result` therefore pages backwards with
   `session/page` from the follow cursor until the target `user/message` and its `turn/start`
   are present, rather than trusting the snapshot. `send` still uses the snapshot only for its
   baseline cursor (and for steer turn context).
4. **`sessions --json` shape.** Spec §8 fixes the plain line format but not JSON; JSON is the
   filtered raw `session/list` rows (same fields callers already resolve against).
5. **`from` on index-less read-back.** The durable log does not record the sender label, so
   `result` found by scanning reports `"from": "unknown"`; the local index carries the real value.
6. **Timeout in plain mode.** To keep "stdout is only assistant text", the rpcId and read-later
   hint go to stderr on timeout; `--json` carries both fields in the object.
7. **CLI `from` default.** `--from` → `$DSH_BRIDGE_FROM` → `"cli"` (spec did not name a CLI
   default; MCP's `"mcp"` default remains T2's).
8. **Subagent sessions.** `session/page` on a subagent session returns `session/agent-busy`
   (host policy: use the parent address). The bounded `result` scan skips such rows; sending to
   them stays out of scope and fails loudly.

### Acceptance evidence (actual commands and output)

Node used: `v24.19.0` (engines `>=22.19`; a runtime guard prints a clear error on older Node).

**1. Typecheck**

```console
$ npm run typecheck
> dsh-bridge@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit
$ echo $?
0
```

**2/8. Full test suite (`npm test`)**

```console
$ npm test
…
✔ blocking send returns exactly the assistant text and records the rpcId (784ms)
✔ --no-prefix sends the raw text (110ms)
✔ --detach returns an rpcId, result is pending then completed (1662ms)
✔ timeout exits 2, names the rpcId, and hints how to read it later (1035ms)
✔ queued send returns its own turn, never the running turn (2635ms)
✔ toolCalls and usage are populated from a real bash tool turn (187ms)
✔ result scans the newest sessions when the send index is gone (175ms)
✔ sessions --json lists staging rows; unknown rpcId is a local error (108ms)
ℹ tests 41
ℹ suites 0
ℹ pass 41
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 12213
```

**3. Live read-only `sessions` and resolution (desktop host, port 49904)**

```console
$ node dist/cli.js sessions --limit 3
f192cdb2-f1a8-44c7-96f5-d4df24fb584b	true	2026-11-23T08:21:16.263Z	You are implementing ticket T1	/Users/<user>/Documents/Agent/deepseek-harness
f441b634-6e45-4b8a-8411-a0baa39853a1	false	2026-11-23T08:20:52.758Z	你在为私有仓 FundingRateArbC（git	/Users/<user>/CodeBase/deepseek-harness/polymarket
session-474d640c-0968-452a-9ee3-5bec233690fa	false	2026-11-23T08:20:05.930Z	跨 harness 向 DeepSeek 会话发消息	/Users/<user>/Documents/Agent/deepseek-harness
$ echo $?
0

$ node dist/cli.js sessions --json | node -e '…count rows…'
{"rows":3050,"first":"f192cdb2-f1a8-44c7-96f5-d4df24fb584b","title":"You are implementing ticket T1"}
$ echo $?
0
```

Auto-discovery (no `--host`) resolved and confirmed the desktop host by itself:

```console
$ node dist/cli.js sessions --limit 1
f192cdb2-f1a8-44c7-96f5-d4df24fb584b	true	2026-11-23T08:21:16.263Z	You are implementing ticket T1	/Users/<user>/Documents/Agent/deepseek-harness
$ echo $?
0
```

Selectors (read-only `sessions`; output cut to `sessionId	title`):

```console
$ node dist/cli.js sessions --session f192cdb2-f1a8-44c7-96f5-d4df24fb584b | cut -f1,4
f192cdb2-f1a8-44c7-96f5-d4df24fb584b	You are implementing ticket T1
$ node dist/cli.js sessions --session 474d640c | cut -f1,4
session-474d640c-0968-452a-9ee3-5bec233690fa	跨 harness 向 DeepSeek 会话发消息
$ node dist/cli.js sessions --title 'ticket t1' | cut -f1,4
f192cdb2-f1a8-44c7-96f5-d4df24fb584b	You are implementing ticket T1
$ node dist/cli.js sessions --cwd /Users/<user>/Documents/Agent/deepseek-harness --limit 2 | cut -f1,4
f192cdb2-f1a8-44c7-96f5-d4df24fb584b	You are implementing ticket T1
session-474d640c-0968-452a-9ee3-5bec233690fa	跨 harness 向 DeepSeek 会话发消息
$ node dist/cli.js sessions --latest | cut -f1,4
f192cdb2-f1a8-44c7-96f5-d4df24fb584b	You are implementing ticket T1
```

Ambiguity and no-selector. `send` resolves **before** opening a follow stream or prompting, so
these fail without touching the live session:

```console
$ node dist/cli.js send probe --session f 2>&1 >/dev/null | head -3
dsh-bridge: target --session f matches 193 sessions; narrow it:
  f192cdb2-f1a8-44c7-96f5-d4df24fb584b	You are implementing ticket T1	/Users/<user>/Documents/Agent/deepseek-harness	2026-11-23T08:21:16.263Z
  f441b634-6e45-4b8a-8411-a0baa39853a1	你在为私有仓 FundingRateArbC（git	/Users/<user>/CodeBase/deepseek-harness/polymarket	2026-11-23T08:20:52.758Z
$ echo ${PIPESTATUS[0]}
1
$ node dist/cli.js send probe 2>&1 >/dev/null
dsh-bridge: send needs a target: pass --session <id|prefix>, --title <substr>, --cwd <path>, or --latest
$ echo $?
1
```

Live read-only follow (no prompt) and live read-back of an existing turn:

```console
$ node --input-type=module -e '…SessionClient.followSession on session-474d…'
host http://127.0.0.1:49904 session session-474d640c-0968-452a-9ee3-5bec233690fa
follow cursor 654 records 361 durable events 361

$ time node dist/cli.js result --rpc-id cbad83eb-ec56-433b-b3d4-c89677a30d77 --json
{"sessionId":"session-474d640c-0968-452a-9ee3-5bec233690fa","turn":4,"status":"completed",
 "textLen":935,"textStart":"Decisions locked. Writing the spec + tickets to an independent repo, then dispatching implementers.\n",
 "toolCalls":[{"name":"bash","ok":true},{"name":"bash","ok":true},{"name":"write","ok":true}],
 "usage":{"inputTokens":4576,"outputTokens":15221,"cacheReadTokens":1731072}}
real	0m1.034s
$ echo $?
0
```

No send was ever issued to the live host; all `send` tests targeted staging.

**4. README quickstart** — the exact commands, run through the linked `dsh-bridge` bin against a
staging host:

```console
$ dsh-bridge sessions --limit 5
session-588935a5-c94b-4276-9a30-fc6d5b6bc93c	false	2026-11-23T08:43:42.834Z		/path/to/dsh-bridge-mcp
$ SESSION=$(dsh-bridge sessions --latest | cut -f1); dsh-bridge send "What are you working on?" --session "$SESSION"
SESSION=session-588935a5-c94b-4276-9a30-fc6d5b6bc93c
QUICKSTART-OK
$ echo $?
0
```

`npm link` produced a working bin (the build marks bins executable so the symlink is runnable):

```console
$ which dsh-bridge
/path/to/node/bin/dsh-bridge
$ dsh-bridge --help | head -1
dsh-bridge — send one message to an existing DeepSeek Harness session
$ npm ls --omit=dev
dsh-bridge@0.1.0 /path/to/dsh-bridge-mcp
└── (empty)
```

### Module boundaries for T2 (MCP shell)

Everything T2 needs is process-level and print-free; the CLI owns output/policy:

```ts
import { SessionClient } from './client.js';
import { resolveTarget } from './resolve.js';
import { sendMessage, exitCodeForStatus } from './run.js';
import { SendIndex, resultMessage } from './result.js';

const client = await SessionClient.connect({ host, dshHome });
const index = new SendIndex(dshHome);
const { result, exitCode, timeoutHint } = await sendMessage({
  client, target, text, from, prefix: true, mode: 'queue',
  timeoutMs, detach: false, force: false, index,
});
```

- `sessionCursor`, `sessionTitle`, `sessionCwd`, `sessionUpdatedAt`, `stripSessionPrefix` are
  exported from `client.ts` for `dsh_sessions` formatting.
- `SendIndex` implements `SendIndexSink`; pass it to `sendMessage` so `dsh_result` works.
- `SendResult` is already the §6 JSON object (`turn` absent for pending/timeout before a turn).
  T2 should return it as `structuredContent` and `JSON.stringify(result)` (or its `text`) as the
  text block; `exitCode`/`timeoutHint` are advisory for CLI only.
- Core throws `BridgeError` subclasses (`CredentialsError`, `HostError`, `ProtocolError`,
  `RpcError`, `ResolutionError`, `AmbiguousTargetError`, `ResultNotFoundError`); map those to
  MCP `isError: true` text. Nothing core writes to stdout/stderr, so the JSON-RPC channel stays
  clean; `SendOutcome.timeoutHint` is the only diagnostic string produced.
- Add `"dsh-bridge-mcp": "dist/mcp.js"` to `package.json` bins; `scripts/postbuild.mjs`
  already chmods `dist/mcp.js` if it exists.
- Node floor helper: `isNodeVersionSupported()` / `nodeVersionMessage()` in `runtime.ts`.

## Review fixes (P1)

Independent review, 2026-11-23. Three P1 defects, fixed on `main`; each fix ships with the
regression test that failed before it. P2/P3 findings are deliberately not addressed here — they
live in [`../backlog.md`](../backlog.md).

### P1-1 — `result` leaked the follow socket, so the process could hang forever

- **Finding.** `resultMessage` opened `session/follow`, then paged history with
  `loadTurnHistory`; nothing closed the socket when that call threw (`session/page` fails with
  `session/agent-busy` for subagent sessions, `gateway/bad-request ... past cursor`, or a
  transient HTTP error). The CLI printed the error and returned 1, but the live socket kept the
  event loop alive, so the process parked indefinitely.
- **Fix.** `src/result.ts:403-442` — the whole open→return body now sits in
  `try { … } finally { stream.close(); }`. The pre-existing explicit closes stay (`close()` is
  idempotent). The `--wait` result is `await`ed inside the `try` so the `finally` cannot close
  the stream before `awaitTurn` consumes it.
- **Test.** `tests/result.test.ts` — *"a pageSession failure after the follow opens still closes
  the stream (P1-1)"*: a fake client whose `pageSession` throws
  `RpcError('session/agent-busy')` while a follow stream is open; asserts the call rejects with
  that error and that the stream was closed.

### P1-2 — a still-running turn's partial text printed on stdout with exit 0

- **Finding.** `resultMessage` put `reconstructed.text` into `SendResult.text` even when the turn
  had no `turn/end` (`status: "pending"`, exit 0), and the CLI prints any non-empty `text`. Spec
  §6 says plain stdout is the **final** assistant text; an unfinished turn has none, so a caller
  reading exit codes could not tell unfinished work from a final answer. `result --wait` reached
  the same state when the stream ended before `turn/end`.
- **Fix.** `src/result.ts:284-309` (`finalFromReconstruction`) and `src/result.ts:333-356`
  (`fromOutcome`, the `--wait` path) — `text` stays `""` while `status: "pending"`; what settled
  so far moves to a new JSON-only field `partialText` on `SendResult` (`src/run.ts:47-51`).
  Plain mode therefore prints nothing (`src/cli.ts:204` already prints `text` only); `--json`
  still reports `status: "pending"` and now also carries `partialText`. `timeout` keeps its
  settled text (spec §5). MCP `dsh_result` is unaffected: its text block already falls back to
  the rpcId when `text` is empty, and `structuredContent` carries the same fields.
- **Tests.**
  - `tests/result.test.ts` — *"a running turn has no final text: pending keeps text empty
    (P1-2)"*: a reconstructed turn with an `assistant/message` text block and no `turn/end`;
    asserts exit 0, `status: "pending"`, `text === ""`, `partialText === "PARTIAL"`.
  - `tests/staging.test.ts` — *"plain result on a running turn prints nothing; --json still
    reports pending"*: a real staged turn whose first step settles text plus a bash tool call and
    whose second model call is held back. While the turn is running, the real CLI in plain mode
    must print nothing and exit 0; `--json` must report `status: "pending"` with `text: ""` and
    `partialText: "PARTIAL-TEXT"`.

### P1-3 — `toolCalls[].ok` was always `false` on 0.1.x-shaped `tool/result`

- **Finding.** `collectToolCalls` linked a `tool/result` to its `tool/call` using only
  `message.toolCallId`, `data.callId`, and `message.callId`. The 0.1.x message shape carries no
  top-level id: the call id is in `message.source.callId` (`{kind:"tool"}`) and
  `message.content[0].toolCallId`, so every call stayed `ok: false` on those logs.
- **Fix.** `src/run.ts:182-197` — the link also tries `message.source.callId` and
  `message.content[0].toolCallId` (spec §3.5).
- **Test.** `tests/render.test.ts` — *"tool results link through the 0.1.x message shape
  (source.callId, content[0].toolCallId)"*: three 0.1.x-shaped results (source-only,
  content-only, source-only with `data.error`) assert `ok` is `true`, `true`, `false`.

### Corrections to claims in the earlier Result section

- **Host versions.** The live desktop app is **0.2.1-rc.2**, not 0.1.5-rc.2; the 0.1.5-rc.2 tree
  is only the DSH source checkout. The desktop app and the staged packaged CLI were therefore
  both 0.2.1-rc.2 — what deviation 2 above calls "verified against both hosts" was really
  0.2.1-rc.2 twice.
- **`toolCalls`.** Acceptance criterion 7's "populated correctly" (and the staging test of the
  same name) held only for the 0.2.x `tool/result` message shape; on 0.1.x-shaped logs every
  `toolCalls[].ok` read `false` until P1-3.

### Fail-before / pass-after (real output, abbreviated)

```console
$ node --test --test-concurrency=1 dist-test/tests/render.test.js   # before P1-3
✖ tool results link through the 0.1.x message shape (source.callId, content[0].toolCallId)
  actual:   [ { name: 'bash', ok: false }, { name: 'read', ok: false }, { name: 'glob', ok: false } ]
  expected: [ { name: 'bash', ok: true }, { name: 'read', ok: true }, { name: 'glob', ok: false } ]
$ node --test --test-concurrency=1 dist-test/tests/render.test.js   # after
✔ tool results link through the 0.1.x message shape (source.callId, content[0].toolCallId) (0.07425ms)
ℹ tests 9  ℹ pass 9  ℹ fail 0

$ node --test --test-concurrency=1 dist-test/tests/result.test.js   # before P1-1/P1-2
✖ a pageSession failure after the follow opens still closes the stream (P1-1)
  AssertionError: the follow socket must be closed when loadTurnHistory throws after the open
  false !== true
✖ a running turn has no final text: pending keeps text empty (P1-2)
  AssertionError: 'PARTIAL' !== ''
  actual: 'PARTIAL'  expected: ''
$ node --test --test-concurrency=1 dist-test/tests/result.test.js   # after
✔ a pageSession failure after the follow opens still closes the stream (P1-1) (1.127125ms)
✔ a running turn has no final text: pending keeps text empty (P1-2) (0.821416ms)
ℹ tests 2  ℹ pass 2  ℹ fail 0

$ node --test --test-concurrency=1 dist-test/tests/staging.test.js  # before P1-2, last test
✖ plain result on a running turn prints nothing; --json still reports pending
  AssertionError: plain stdout must carry the final text only, and this turn has none
  actual: 'PARTIAL-TEXT\n'  expected: ''
$ node --test --test-concurrency=1 dist-test/tests/staging.test.js  # after
✔ plain result on a running turn prints nothing; --json still reports pending (218.752333ms)
ℹ tests 9  ℹ pass 9  ℹ fail 0
```

Final state: `npm run typecheck` clean; `npm test` 57 tests, 57 pass, 0 fail (was 53 before the
four new regression tests).
