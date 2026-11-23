# R2 — URL-token authentication, `doctor`, `setup`, `examples/`

Slice R2 of the open-source release. Contract: [`docs/release.md`](../release.md), sections
"Authentication — two paths, automatic", "New commands", and the `examples/` part of the repository
layout. Status: complete. Evidence below was produced on 2026-11-23 with Node `v24.19.0` on macOS.

**In scope:** the URL-token auth path (exchange, precedence, secret hygiene), `dsh-bridge doctor
[--json]`, `dsh-bridge setup <harness> [--write] [--from <name>]`, and `examples/`.

**Deliberately not in this slice** (owned by other slices): README rewrite (EN/zh), `docs/spec.md` →
`docs/protocol.md`, moving tickets to `docs/dev/`, CI changes, package metadata. `src/mcp.ts` and
the `send`/`result`/MCP surfaces are unchanged: the only observable change for an existing caller is
that a configured URL token is now used instead of ignored.

In transcripts below, machine paths are shortened to `<repo>`, `<node>`, `<tmp>`, and every token
value to `<token>`. Nothing else was edited. Tokens and cookies are never printed anywhere — that is
enforced by tests, not by editing these transcripts.

## 1. Precedence — as implemented

`resolveHost` (`src/host.ts`) now resolves auth and host together:

| # | Input | Auth path | `ResolvedHost.source` |
|---|---|---|---|
| 1 | `--url <url>` | `url-token` | `url` |
| 2 | `DSH_BRIDGE_URL` | `url-token` | `url-env` |
| 3 | `--host <origin>` | `credentials` | `flag` |
| 4 | `DSH_BRIDGE_HOST` | `credentials` | `env` |
| 5 | config `"url"` **with** `?token=` | `url-token` | `config-url` |
| 6 | config `"url"` **without** a token | `credentials` (uses its origin) | `config-url` |
| 7 | config `"host"` | `credentials` | `config-host` |
| 8 | platform discovery (loopback only) | `credentials` | `discovery` |

Rules that fall out of the table:

- **URL token wins over credential minting**, whether it came from `--url`, `DSH_BRIDGE_URL`, or the
  config file. `doctor` reports `authPath: "url-token"` and, when a usable credentials record also
  exists, says so explicitly (`credentialsAvailable: true`, "the URL token wins").
- **A URL also carries the origin.** If `--url`/`DSH_BRIDGE_URL` is present *and*
  `--host`/`DSH_BRIDGE_HOST` is present, both must name the same origin; otherwise this is a
  `HostError` naming the two origins (never a silent pick, never a token echo). The exchange is
  always made against the URL's own origin.
- An explicit `--host`/`DSH_BRIDGE_HOST` outranks the config file; a token in the config `url` is
  then simply not consulted (the user addressed this call to another host).
- **No fallback, ever, on a failed exchange** — not for `--url`, not for `DSH_BRIDGE_URL`, and not
  for the config file's `url`. A broken token stays visible. Rationale: two auth paths that can
  silently substitute for each other are two paths you cannot debug; and a stale config token is a
  fact the user needs to see. The config-inherited failure names the config file and suggests
  copying the current URL. (This was the judgment call the brief left open; the alternative —
  silently falling back to credentials for a config-inherited token — was rejected.)
- The credentials path is unchanged in behaviour, except that a missing/unusable credential record
  now appends the alternative: for a `dsh web` host pass the URL it printed (`--url` /
  `DSH_BRIDGE_URL`); for the desktop app start DSH once with its Web host.
- The cookie lives only in `ResolvedHost` / `SessionClient` memory. No auth file is written; the
  only file the bridge writes is the send index (`$DSH_HOME/dsh-bridge/sends.jsonl`).

`SessionClient` gained `authPath`/`credentialsAvailable` (read-only) and `RpcTransport` takes the
auth path so a 401/403 hint says "copy the URL the running instance printed" for the URL path and
"restart DSH" (rotated secret) for the credentials path.

## 2. The exchange (`src/urltoken.ts`)

One `GET <url>` with `redirect: 'manual'`. Only `303` **with** `Set-Cookie` is accepted; the cookie
is the `name=value` pair before the first `;`. The token is extracted from `?token=` and never
validated against DSH internals, which is what makes this path survive DSH cookie-scheme changes.

Trust rules that mirror the credentials path:

- the URL must be absolute `http(s)` and point at the DSH Web root (`/`) — `HostEndpoint` still
  rejects paths/queries for addressing, and only the URL's origin is ever addressed;
- redirects are not followed, so the token cannot be bounced to another authority;
- the resulting cookie is returned with its origin and used for that origin only (the same
  authority the token was issued for);
- nothing is minted, so a locally-derived cookie never leaves the machine on this path.

Failure modes (all `ProtocolError`/`HostError`, all naming the expected result and the fix):

| Condition | Message shape |
|---|---|
| status is not 303 | `URL-token exchange with <origin> returned HTTP <status>; expected 303 with Set-Cookie (DSH's launch flow). The URL came from --url (<redacted url>). Copy the URL that dsh web printed for the running instance and retry.` |
| 303 but no `Set-Cookie` | `… returned HTTP 303 but no Set-Cookie header; expected 303 with Set-Cookie. DSH did not hand out a browser cookie: check that the token belongs to the running instance.` |
| malformed pair | `… returned a Set-Cookie value that is not a name=value pair` |
| transport/timeout | `cannot reach DSH at <origin> to exchange the URL token from <source>: …` / `timed out after 10000 ms exchanging the URL token with <origin> (<redacted url>)` |
| missing/blank `?token=` | `<source> has no ?token= value. Use the full URL dsh web printed (…/?token=…), or use --host / DSH_BRIDGE_HOST / the config "host" key for a plain origin.` |
| URL/`--host` origin mismatch | `--url addresses <a> but --host addresses <b>; they must name the same origin…` |

The redacted-URL helper (`redactUrl`) replaces only the `token` query value (`?token=…`), including
for input that does not parse as a URL. It is the only function that may put a URL into a message.

Proof from the staging run — a deliberate bad token is reported and nothing else is tried:

```console
$ dsh-bridge doctor --url http://127.0.0.1:51544/?token=broken --dsh-home <staging-home>
dsh-bridge doctor

  host          unresolved
  auth          unresolved
  reachability  not checked
  session/list  not run
  sessions      0 visible

  FAIL  host: unresolved: URL-token exchange with http://127.0.0.1:51544 returned HTTP 401; expected 303 with Set-Cookie (DSH's launch flow). The URL came from --url (http://127.0.0.1:51544/?token=…). Copy the URL that dsh web printed for the running instance and retry.
        next: Fix that failure, then re-run `dsh-bridge doctor`. For a `dsh web` host, pass the URL it printed with --url (or set DSH_BRIDGE_URL); for the desktop app, start DSH once with its Web host so the credentials record exists; to pin a host, use --host http://127.0.0.1:<port>.
  FAIL  auth: not reached: no host/auth path produced a cookie
        next: Fix the host/auth failure above, then re-run `dsh-bridge doctor`.
  FAIL  reachability: not checked: no resolved host
        next: Fix the host failure above, then re-run `dsh-bridge doctor`.
  FAIL  session/list: not run: no resolved host
        next: Fix the host failure above, then re-run `dsh-bridge doctor`.
  FAIL  sessions: not counted: no resolved host
        next: Fix the host failure above, then re-run `dsh-bridge doctor`.
exit: 1
```

## 3. `dsh-bridge doctor [--json]`

One screen: resolved host + how, auth path (+ whether the other path also exists), a real
authenticated `session/list`, visible session count, reachability latency, and a concrete next step
for every failing check. **Exit 0 only when a `send` could succeed**: the probe was accepted and at
least one session is visible (a send with no target cannot succeed, so 0 sessions is exit 1 with
"open or create a session").

### JSON contract (stable field names)

`doctor --json` prints exactly one object:

| field | type | meaning |
|---|---|---|
| `ok` | boolean | true only when the probe was accepted and `sessionCount > 0` |
| `host` | `string \| null` | resolved origin, never a URL with a token |
| `hostSource` | `flag \| url \| env \| url-env \| config-url \| config-host \| discovery \| null` | how the host was resolved |
| `authPath` | `url-token \| credentials \| null` | which path produced the cookie |
| `authSource` | `flag \| env \| config \| credentials \| null` | which input supplied the token / the credential file |
| `credentialsAvailable` | boolean | a usable credential record also exists (the URL still won) |
| `reachability` | `{ ok, latencyMs, detail }` | `GET <origin>/` timed; **any** HTTP response counts (the real host answers 401 to an unauthenticated `/`) |
| `probe` | `{ endpoint: "session/list", status: "accepted" \| "denied" \| "unreachable" \| "error", latencyMs, detail }` | the authenticated probe |
| `sessionCount` | number | rows visible to `session/list`; 0 when the probe failed |
| `checks` | `{ name, ok, detail, nextStep }[]` | fixed order `host`, `auth`, `reachability`, `session/list`, `sessions` |

`ok`, `host`, `hostSource`, `authPath`, `authSource`, `credentialsAvailable`, `probe.status`,
`probe.latencyMs`, `reachability.latencyMs`, `sessionCount`, and `checks[].name`/`ok` are the stable
contract; `detail`/`nextStep` are human text and may be reworded. Exit code: 0 iff `ok`, else 1.

### Evidence — both paths, same host

URL-token path (staging `dsh web`, `DSH_HOME` pointed at a non-existent directory):

```console
$ dsh-bridge doctor --url http://127.0.0.1:51463/?token=<token>
dsh-bridge doctor

  host          http://127.0.0.1:51463  (via --url)
  auth          url-token  (--url)
  reachability  HTTP 401 from http://127.0.0.1:51463 in 2 ms (reachable)
  session/list  accepted in 9 ms
  sessions      1 visible

  ok — the bridge can send through this host.
exit: 0

$ dsh-bridge doctor --url http://127.0.0.1:51463/?token=<token> --json
{"ok":true,"host":"http://127.0.0.1:51463","hostSource":"url","authPath":"url-token","authSource":"flag","credentialsAvailable":false,"reachability":{"ok":true,"latencyMs":2,"detail":"HTTP 401 from http://127.0.0.1:51463 in 2 ms (reachable)"},"probe":{"endpoint":"session/list","status":"accepted","latencyMs":5,"detail":"accepted in 5 ms"},"sessionCount":1,"checks":[{"name":"host","ok":true,"detail":"http://127.0.0.1:51463 — via --url","nextStep":null},{"name":"auth","ok":true,"detail":"--url produced the cookie","nextStep":null},{"name":"reachability","ok":true,"detail":"HTTP 401 from http://127.0.0.1:51463 in 2 ms (reachable)","nextStep":null},{"name":"session/list","ok":true,"detail":"accepted in 5 ms (authenticated as url-token)","nextStep":null},{"name":"sessions","ok":true,"detail":"1 session(s) visible","nextStep":null}]}
```

Credentials path (same staging host, its real `DSH_HOME`):

```console
$ dsh-bridge doctor --host http://127.0.0.1:51463 --dsh-home <staging-home>
dsh-bridge doctor

  host          http://127.0.0.1:51463  (via --host)
  auth          credentials  ($DSH_HOME/.credentials.yaml)
  reachability  HTTP 401 from http://127.0.0.1:51463 in 12 ms (reachable)
  session/list  accepted in 4 ms
  sessions      2 visible

  ok — the bridge can send through this host.
exit: 0
```

Credentials path against the live desktop host (read-only; nothing prompted):

```console
$ dsh-bridge doctor
dsh-bridge doctor

  host          http://127.0.0.1:49904  (via automatic loopback discovery)
  auth          credentials  ($DSH_HOME/.credentials.yaml)
  reachability  HTTP 401 from http://127.0.0.1:49904 in 4 ms (reachable)
  session/list  accepted in 475 ms
  sessions      3061 visible

  ok — the bridge can send through this host.
exit: 0
```

When both paths are configured, the same screen reports the URL path plus "a credential record also
exists — the URL token wins"; that is covered by `tests/doctor.test.ts` ("both paths configured").

## 4. URL-token send — the important one

Staging `dsh web` with a stub provider, no credential file, `DSH_HOME` at a directory that does not
exist:

```console
$ dsh-bridge send "r2 url-token probe" --url http://127.0.0.1:51463/?token=<token> --session session-64d48e08-… --timeout 20
R2-URL-TOKEN-PONG
exit: 0
```

`tests/staging.test.ts` automates exactly this: it starts the staging instance, takes the
`dsh web: http://127.0.0.1:<port>/?token=…` line the harness already captured
(`Staging.launchUrl`), spawns the CLI with `--url` and `DSH_HOME=<staging-home>/no-such-dsh-home`,
asserts exit 0 and the assistant text, asserts the credentials file still does not exist, and
asserts the token appears in neither stdout nor stderr. A second test runs `doctor --url` the same
way and asserts `authPath: "url-token"`, `probe.status: "accepted"`.

Hygiene from the same evidence run (every captured stdout/stderr searched):

```text
===== hygiene =====
captured outputs containing the URL token: 0
```

The token is reusable across exchanges within one DSH launch (verified: two `GET`s of the same
launch URL both answered `303` + `Set-Cookie`), so `doctor` followed by `send` needs no re-copy.

## 5. `dsh-bridge setup <harness> [--write] [--from <name>]`

Eight harness names: `claude-code`, `antigravity`, `codex`, `cursor`, `cline`, `continue`, `zed`,
`raw`. The block is generated from **the running machine**:

- package installed from npm — detected as `process.argv[1]` containing a `node_modules` segment —
  → `"command": "npx", "args": ["-y", "dsh-bridge-mcp"]` (the `-y` only suppresses npx's
  interactive install prompt, which a GUI-started process cannot answer);
- otherwise → `process.execPath` plus the absolute `dist/mcp.js` path of this checkout/install.

`DSH_BRIDGE_FROM` defaults to the harness name (`--from` overrides). GUI harnesses also get
`"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"` (the `docs/install.md` §4 note; on Windows the generator
emits `%SystemRoot%\System32`, untested). CLI harnesses (`claude-code`, `codex`, `raw`) do not.

| harness | destination | format | GUI `PATH` | `--write` |
|---|---|---|---|---|
| `claude-code` | `~/.claude.json` under `mcpServers` (or project `.mcp.json`) | JSON | — | `claude mcp add --scope user …` |
| `antigravity` | `~/.gemini/config/mcp_config.json` under `mcpServers` | JSON | yes | merge + timestamped backup |
| `codex` | `~/.codex/config.toml` as `[mcp_servers.dsh-bridge]` | TOML | — | print only |
| `cursor` | `~/.cursor/mcp.json` or `.cursor/mcp.json` under `mcpServers` | JSON | yes | print only |
| `cline` | `~/.cline/data/settings/cline_mcp_settings.json` (VS Code: globalStorage) | JSON + `disabled`/`autoApprove` | yes | print only |
| `continue` | `~/.continue/config.yaml`, `mcpServers:` **list** | YAML | yes | print only |
| `zed` | `settings.json` under `context_servers` | JSON | yes | print only |
| `raw` | the client's stdio block | JSON | — | print only |

Every harness prints; `--write` is implemented for exactly two and refused for the rest with a
message saying so. `--write` for anything else exits 1 and writes nothing. `setup` has no `--json`
(text is the deliverable); passing it is an error rather than an undocumented shape.

### `--write` per harness

- **`claude-code`** — prints the exact command, then runs it with `spawnSync('claude', …)` and
  inherits its output:
  `claude mcp add --scope user dsh-bridge -e DSH_BRIDGE_FROM=claude-code -- <node> <repo>/dist/mcp.js`.
  A missing or failing `claude` is an error naming the printed command as the manual fallback.
  Evidence, with a stand-in `claude` on `PATH` (no real Claude config was touched):

  ```console
  $ PATH=<tmp>/bin:$PATH dsh-bridge setup claude-code --write
  dsh-bridge: running: claude mcp add --scope user dsh-bridge -e DSH_BRIDGE_FROM=claude-code -- <node> <repo>/dist/mcp.js
  claude: added MCP server dsh-bridge
  dsh-bridge: registered with Claude Code (scope user).
  exit: 0

  --- argv the stand-in `claude` received ---
  mcp
  add
  --scope
  user
  dsh-bridge
  -e
  DSH_BRIDGE_FROM=claude-code
  --
  <node>
  <repo>/dist/mcp.js
  ```

- **`antigravity`** — parses the existing file first (invalid JSON or a non-object `mcpServers` is
  a `SetupError` and nothing is written), copies it to
  `mcp_config.json.bak-dsh-bridge-mcp-<UTC stamp>` when it exists, refuses to replace an existing
  `dsh-bridge` entry without `--force`, then writes through a temp file + rename. Evidence in a
  temp `HOME`:

  ```console
  $ dsh-bridge setup antigravity --write   (HOME=<tmp>)
  dsh-bridge: wrote <tmp>/.gemini/config/mcp_config.json
  exit: 0

  $ dsh-bridge setup antigravity --write   (dsh-bridge entry already present)
  dsh-bridge: <tmp>/.gemini/config/mcp_config.json already has a "dsh-bridge" entry. Re-run with --force to replace it (a timestamped backup is taken first). Nothing was written.
  exit: 1

  $ dsh-bridge setup antigravity --write --force
  dsh-bridge: wrote <tmp>/.gemini/config/mcp_config.json
  dsh-bridge: backup <tmp>/.gemini/config/mcp_config.json.bak-dsh-bridge-mcp-20261123T140744Z
  dsh-bridge: replaced the existing dsh-bridge entry (--force).
  exit: 0
  ```

  After `--force`, an unrelated `mcpServers.other-server` entry in the same file survived the merge.

No other harness configuration file is written by any code path.

### npm-install detection, proved by running through a `node_modules` tree

```console
$ node <tmp>/node_modules/dsh-bridge-mcp/dist/cli.js setup cursor
dsh-bridge setup cursor

harness      Cursor
destination  global: ~/.cursor/mcp.json, project: .cursor/mcp.json — both under "mcpServers"
sender       cursor  (DSH_BRIDGE_FROM)
launch       npx -y dsh-bridge-mcp (package installed from npm)

{
  "mcpServers": {
    "dsh-bridge": {
      "command": "npx",
      "args": [
        "-y",
        "dsh-bridge-mcp"
      ],
      "env": {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "DSH_BRIDGE_FROM": "cursor"
      }
    }
  }
}

$ node <tmp>/node_modules/dsh-bridge-mcp/dist/cli.js setup claude-code
  claude mcp add --scope user dsh-bridge -e DSH_BRIDGE_FROM=claude-code -- npx -y dsh-bridge-mcp
```

### One full output per harness family

CLI-family representative (`codex`, TOML):

```console
$ dsh-bridge setup codex
dsh-bridge setup codex

harness      Codex CLI
destination  ~/.codex/config.toml as [mcp_servers.dsh-bridge]
sender       codex  (DSH_BRIDGE_FROM)
launch       this node binary + the absolute dist/mcp.js path (source checkout)

[mcp_servers.dsh-bridge]
command = "<node>"
args = ["<repo>/dist/mcp.js"]

[mcp_servers.dsh-bridge.env]
DSH_BRIDGE_FROM = "codex"

note      the TOML shape (command/args/env) follows OpenAI's MCP configuration; it was not run against a Codex install here (none present).
--write is not supported for Codex CLI: paste the block into the file above.
```

GUI-JSON-family representative (`antigravity`):

```console
$ dsh-bridge setup antigravity
dsh-bridge setup antigravity

harness      Antigravity
destination  ~/.gemini/config/mcp_config.json under "mcpServers"
sender       antigravity  (DSH_BRIDGE_FROM)
launch       this node binary + the absolute dist/mcp.js path (source checkout)

{
  "mcpServers": {
    "dsh-bridge": {
      "command": "<node>",
      "args": [
        "<repo>/dist/mcp.js"
      ],
      "env": {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "DSH_BRIDGE_FROM": "antigravity"
      }
    }
  }
}

note      the merge, backup, and --force refusal were verified against a temp HOME; the block matches the dsh-bridge entry already present in this machine's Antigravity config, but Antigravity itself was not launched to watch it connect.
--write merges this into ~/.gemini/config/mcp_config.json after a timestamped backup; an existing dsh-bridge entry is only replaced with --force.
```

YAML-family representative (`continue`):

```console
$ dsh-bridge setup continue
dsh-bridge setup continue

harness      Continue
destination  ~/.continue/config.yaml under the top-level mcpServers: list
sender       continue  (DSH_BRIDGE_FROM)
launch       this node binary + the absolute dist/mcp.js path (source checkout)

mcpServers:
  - name: dsh-bridge
    command: "<node>"
    args:
      - "<repo>/dist/mcp.js"
    env:
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin"
      DSH_BRIDGE_FROM: "continue"

note      the YAML list shape follows Continue's MCP reference; it was not run against a Continue install here (none present).
--write is not supported for Continue: paste the block into the file above.
```

`claude-code`, `cursor`, `cline`, `zed`, `raw` follow the same shape and are asserted in
`tests/setup.test.ts` (wrappers, GUI PATH, `disabled`/`autoApprove`, `context_servers`).

## 6. `examples/`

Nine files, one per harness plus two paths:

| file | covers |
|---|---|
| `examples/claude-code.md` | `~/.claude.json` / `.mcp.json`, `claude mcp add` |
| `examples/antigravity.md` | `~/.gemini/config/mcp_config.json` |
| `examples/codex.md` | `~/.codex/config.toml` |
| `examples/cursor.md` | `~/.cursor/mcp.json` / `.cursor/mcp.json` |
| `examples/cline.md` | `cline_mcp_settings.json` + `autoApprove` |
| `examples/continue.md` | `~/.continue/config.yaml` list |
| `examples/zed.md` | `settings.json` `context_servers` |
| `examples/remote-host.md` | URL-token path against a remote DSH over an SSH forward |
| `examples/cli-only.md` | no MCP; shell/Bash-tool usage, exit codes, detach/result |

Each carries the exact block, where it goes, and one line stating what was verified versus not.
No machine-specific paths, usernames, or npm cache paths appear; placeholders are
`<absolute-path-to-node>`, `<absolute-path-to-dist>`, `$(command -v node)`, or `npx dsh-bridge-mcp`.
Only markdown was added — no `examples/*.json`, so the CI JSON-validation job has nothing to parse
(if JSON files are added later, CI already validates them).

A grep over `examples/` for absolute user paths, npm/nvm install paths, and the project owner's
username returns no matches (same rule as R1 §5). The examples use only the placeholders named
above.

## 7. Tests added (88 → 135)

| file | new | covers |
|---|---|---|
| `tests/urltoken.test.ts` | 17 | parse/redact/exchange (real `node:http` servers), non-303, redirect, missing cookie, malformed pair, transport error, precedence, no-fallback, origin mismatch, config-token failure, bad config token |
| `tests/doctor.test.ts` | 7 | accepted (both paths), denied, unreachable, failed exchange, no host at all, stable JSON keys, no secret in text/JSON |
| `tests/setup.test.ts` | 21 | rendering for all 8 harnesses, npm detection, `--from`, `--write` for claude-code (seam + real spawn) and antigravity (create/merge/refuse/force/invalid JSON), CLI wiring |
| `tests/staging.test.ts` | 2 | URL-token-only send; `doctor --url` against a staged `dsh web` |
| `tests/host.test.ts` | rewrote 1 | config `url` with a token is the URL-token path; without one it is an origin + credentials |

The rewritten `tests/host.test.ts` case previously asserted "config url contributes only its
origin"; that is now false by contract, so the assertion changed with the behaviour.

## 8. Verification

```console
$ npm run typecheck
> dsh-bridge-mcp@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit
$ npm test
…
ℹ tests 135
ℹ suites 0
ℹ pass 135
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 39224.02925
```

Self-skip re-check with a deliberately unusable `DSH_BIN` (staging tests skip, exit 0):

```console
$ env DSH_BIN=/nonexistent npm test
…
ℹ tests 135
ℹ suites 0
ℹ pass 119
ℹ fail 0
ℹ cancelled 0
ℹ skipped 16
ℹ todo 0
ℹ duration_ms 18682.531375
$ echo $?
0
```

(`16` = the 14 pre-existing staging skips + the 2 new URL-token staging tests.)

No live session was prompted: the live host was used read-only (`doctor`'s `session/list`), and every
`send` in this slice targeted a disposable staging instance with a stub provider.

## 9. Deliberately deferred / not verified

- **Public docs**: `README.md`, `README.zh.md`, `docs/usage.md`, and `docs/install.md` do not yet
  mention `doctor`, `setup`, or `examples/`, and `docs/spec.md` is not renamed to
  `docs/protocol.md`. Those belong to the docs/metadata slices; this ticket is the reference the
  docs slice can lift from.
- **Live harness runs**: Cline, Cline-on-VS-Code globalStorage, Continue, Cursor, Zed, and Codex
  are not installed on the machine this was written on, so their blocks follow each project's
  current documentation but were not exercised against the app. Antigravity's block matches the
  entry this machine already has, but Antigravity itself was not launched.
- **`claude mcp add` against a real Claude Code install**: deliberately not run (it would modify a
  user config). Exercised with a stand-in executable; the JSON block is the entry that command
  writes.
- **Windows**: `setup` emits `%SystemRoot%\System32` as the GUI `PATH` and uses `\` separators for
  the absolute paths, but was not run on Windows. Sending on Windows remains untested per contract.
- **MCP `url` input**: the MCP server has no per-call URL argument (that would change the tool
  surface). URL-token auth reaches MCP through `DSH_BRIDGE_URL` or the config file, which is the
  contract's input list.
- **A very large output for a broken host**: `doctor`'s failed-resolution screen lists all five
  checks with a next step each, which is verbose but deliberately never leaves a failing check
  without a fix.

## 10. Files changed

New: `src/urltoken.ts`, `src/doctor.ts`, `src/setup.ts`, `tests/urltoken.test.ts`,
`tests/doctor.test.ts`, `tests/setup.test.ts`, `examples/*.md` (9), this file.

Changed: `src/host.ts` (auth/host resolution, auth-aware 401/403 hints), `src/client.ts`
(`url` option, `authPath`, `credentialsAvailable`), `src/cli.ts` (`--url`, `doctor`, `setup`,
usage), `src/errors.ts` (`SetupError`), `tests/host.test.ts`, `tests/staging.ts` (`launchUrl`),
`tests/staging.test.ts`.
