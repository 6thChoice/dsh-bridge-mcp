# T1 — Core client + CLI (`sessions`, `send`, `result`)

Implements §2–§9 of [`../spec.md`](../spec.md). This ticket is the whole kernel: auth, discovery,
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
  (reports `dsh web: http://127.0.0.1:<port>/?token=...`). It runs 0.2.1-rc.2; the live desktop app
  is 0.1.5-rc.2. The wire surface used here is identical on both — if something differs, report it.
- The staging instance's own cookie secret is minted on first Connection activation into its
  temp `DSH_HOME`; wait for readiness before reading it.
- Keep `send` from prompting a staging session that has no configured provider: pass
  `DEEPSEEK_API_KEY=dummy` + `DEEPSEEK_BASE_URL=http://127.0.0.1:<stub-port>` and `--no-open`.
