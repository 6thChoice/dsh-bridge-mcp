# R1 — Decouple `dsh-bridge-mcp` from this machine

Slice R1 of the open-source release. Contract: [`docs/release.md`](../release.md), sections
"Identity", "Portability", and "Config file". Status: complete. Evidence below was produced on
2026-11-23 with Node `v24.19.0` on macOS.

**In scope:** package identity, the optional config file, portable host discovery, staging-test
binary resolution + self-skip, and removal of machine-specific paths from tracked user docs.

**Deliberately not in this slice:** the URL-token auth path (`--url` / `DSH_BRIDGE_URL` / the
config `url` token), `doctor`, `setup`, `examples/`, LICENSE/CI/README rewrite, moving tickets to
`docs/dev/`.

## 1. Package identity

`package.json`:

- `name` → `dsh-bridge-mcp`; `description` states the process-external-client positioning.
- added `license: "MIT"`, `author`, `repository`, `homepage`, `bugs`, `keywords`,
  `files: ["dist"]` (already present), `publishConfig.access: "public"`.
- both bins stay: `dsh-bridge` → `dist/cli.js`, `dsh-bridge-mcp` → `dist/mcp.js`.
- scripts and dependencies are unchanged; `package-lock.json` was regenerated with
  `npm install --package-lock-only --ignore-scripts` so its `name`/`bin` metadata matches.
- `src/mcp.ts`'s `readServerVersion()` accepts the new package name (and the historical name, so
  an in-tree `src/` import still works).

The CLI command name is still `dsh-bridge`; nothing in the CLI/`send`/`result`/MCP tool surface
changed except where the contract requires it.

## 2. Host discovery ladder (as implemented)

```text
--host  ->  DSH_BRIDGE_HOST  ->  config file  ->  platform discovery
(flag)      (env)                (url, host)      (confirmed by session/list)
```

`Credential`/`ResolvedHost.source` reports the rung that won: `flag`, `env`, `config-url`,
`config-host`, or `discovery`. The config file is read **and validated on every resolve**, even
when `--host` or `DSH_BRIDGE_HOST` wins, so a malformed config is never silently ignored.

The DSH-home ladder is separate and feeds credentials plus the send index:
`--dsh-home` → `$DSH_HOME` → config `dshHome` → `~/.dsh`. `~` is expanded at every rung; the
shell already does that for flags, but not for config values.

Config file: `${XDG_CONFIG_HOME:-~/.config}/dsh-bridge/config.json` (optional).

```json
{ "url": "http://127.0.0.1:49904/?token=…", "host": "http://127.0.0.1:49904", "dshHome": "~/.dsh" }
```

Rules enforced in `src/config.ts`:

- only `url`, `host`, `dshHome`; any other key → `ConfigError` naming the file and the key(s);
- invalid JSON / non-object / non-string / empty value → `ConfigError` naming the file and the
  offending key;
- `url` wins over `host`; only its origin is used for addressing (a `?token=` is not echoed in
  any error and is not consumed yet — see §7);
- a relative `$XDG_CONFIG_HOME` is ignored per the XDG spec (falls back to `~/.config`);
- a missing file is fine (not an error); an unreadable or malformed one is loud.

Every discovery failure is caller-aware. The MCP server resolves with `caller: 'mcp'`, the CLI
with `caller: 'cli'`, which changes only the fix hint:

```console
$ node .r1-hint.mjs
--- caller=cli ---
automatic host discovery could not find a DSH Web host on Linux (linux).
Tried:
  ss (ss -ltnp): cannot run: spawnSync ss ENOENT
  lsof (lsof -nP): ran, found no matching loopback listener
Pass --host http://127.0.0.1:<port>, or add "host" to the dsh-bridge config file.
--- caller=mcp ---
automatic host discovery could not find a DSH Web host on Linux (linux).
Tried:
  ss (ss -ltnp): cannot run: spawnSync ss ENOENT
  lsof (lsof -nP): ran, found no matching loopback listener
Set DSH_BRIDGE_HOST=http://127.0.0.1:<port> in the MCP server environment, or add "host" to the dsh-bridge config file.
```

## 3. Platform discovery

Each probe enumerates loopback listeners, keeps sockets whose owning process command line
mentions `DeepSeek Harness` or `dsh`, then **every candidate is confirmed by an authenticated
`session/list`** before it is accepted (first confirmed wins). A probe that runs but finds no
matching listener falls through to the next probe.

| Platform | Probes, in order |
|---|---|
| macOS (`darwin`) | `lsof -nP -iTCP -sTCP:LISTEN -u <uid> -a` (unchanged) |
| Linux (`linux`) | `ss -ltnp`, then `lsof` (same lsof command) |
| Windows (`win32`) | `powershell -NoProfile -NonInteractive -Command Get-NetTCPConnection …` |

Linux: `ss` gives the listener and `pid`, then `ps -p <pids> -o pid=,command=` supplies full
command lines (same `ps` helper as macOS). A listener with no visible `pid` (another user's
process) is skipped because it cannot be attributed or confirmed. If `ss` cannot spawn or finds
no candidate, `lsof` is tried.

Windows — why this shape:

- one `powershell -NoProfile -NonInteractive -Command` invocation, so no user profile can prompt
  or inject output, and no interactive window is created (`windowsHide`);
- `Get-NetTCPConnection -State Listen` is the native listener enumerator; the script filters
  `127.0.0.1` / `::1` and looks up each owning pid's command line with
  `Get-CimInstance Win32_Process`, then emits compact JSON (`Address`, `Port`, `Pid`, `Command`);
- `ConvertTo-Json` unwraps a single-element pipeline into an object, so the parser accepts both
  an array and a single object (and empty/`null` output);
- this is **best effort, untested for sending** (release contract). The authenticated
  `session/list` confirmation remains the gate, so a wrong candidate is rejected, not used.
- The PowerShell command, `ss`/`lsof` parsers, probe ordering, and caller-aware failures are
  unit-tested with fake probes and fixture output; CI does not need Linux or Windows binaries.

## 4. Staging binary resolution and self-skip

`tests/staging.ts` no longer hardcodes a binary as the first choice:

```text
DSH_BIN (when set: authoritative; no further fallback)
  -> dsh on PATH
  -> /Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh (macOS only)
  -> self-skip
```

A set-but-unrunnable `DSH_BIN` is treated as authoritative: the operator pinned a binary, so
using a different one would silently test the wrong thing. That is what makes the
`DSH_BIN=/nonexistent` check below deterministic even on a machine that also has the app bundle.

Exact skip behaviour:

- `stagingSkipReason()` returns `false` when a runnable binary was found, otherwise a node:test
  skip reason such as
  `staging tests skipped: DSH_BIN=/nonexistent is not a runnable dsh (set DSH_BIN to a dsh >= 0.2 CLI)`;
- in `tests/staging.test.ts` and the staging section of `tests/mcp.test.ts`, the `before` hook
  returns early and every staging test is registered with `{ skip: stagingSkip }`; `after` uses
  `staging?.stop()`, so nothing is spawned;
- protocol/live-host tests in `tests/mcp.test.ts` are untouched and still run.

Proof (full `npm test` with a deliberately unusable `DSH_BIN`; output excerpt, exit code 0):

```console
$ env DSH_BIN=/nonexistent npm test
…
﹣ blocking send returns exactly the assistant text and records the rpcId (0.233667ms) # staging tests skipped: DSH_BIN=/nonexistent is not a runnable dsh (set DSH_BIN to a dsh >= 0.2 CLI)
…  (the other 13 staging tests skip the same way)
ℹ tests 88
ℹ suites 0
ℹ pass 74
ℹ fail 0
ℹ cancelled 0
ℹ skipped 14
ℹ todo 0
ℹ duration_ms 17124.393875
$ echo $?
0
```

Staging-only view (9 skips, no failures, exit 0):

```console
$ env DSH_BIN=/nonexistent PATH=/usr/bin:/bin "$(command -v node)" \
    --test --test-concurrency=1 dist-test/tests/staging.test.js
…
ℹ tests 9
ℹ suites 0
ℹ pass 0
ℹ fail 0
ℹ cancelled 0
ℹ skipped 9
ℹ todo 0
ℹ duration_ms 53.956541
```

## 5. Machine-path removal

Changed: `README.md`, `docs/install.md`, `docs/usage.md`, `docs/spec.md` (plus the discovery
section), `docs/backlog.md` (records P3-7 fixed). Absolute Node/`nvm`/project paths became
`<absolute-path-to-node>`, `$(command -v node)`, `$(pwd)/dist/mcp.js`, `<path-to-project>`,
`<absolute-path-to-session-cwd>`. The macOS app-bundle path remains only where the contract
requires it: the last-resort staging resolver in `tests/staging.ts`.

`docs/tickets/*` and `docs/release.md` intentionally keep their historical command output; they
move to `docs/dev/` in a later slice. This file lives in `docs/dev/`, the evidence bucket.

Proof over all tracked files except this evidence bucket and the deferred historical docs:

```console
$ git ls-files -z ':!:docs/dev/**' ':!:docs/tickets/**' ':!:docs/release.md' \
  | xargs -0 grep -nH -e '/Users/' -e '6thChoice' -e '\.nvm' || echo 'NO MATCHES'
NO MATCHES

$ git ls-files -z ':!:docs/dev/**' ':!:docs/tickets/**' ':!:docs/release.md' \
  | xargs -0 grep -nH -e '~/CodeBase' -e '~/Documents' || echo 'NO MATCHES'
NO MATCHES
```

A grep without exclusions still finds `/Users/` only in `docs/release.md` (the sentence stating
the rule) and `docs/tickets/T1,T2,T3` (historical command transcripts, deferred to `docs/dev/`):

```console
$ git grep -l '/Users/'
docs/release.md
docs/tickets/T1-core-cli.md
docs/tickets/T2-mcp-shell.md
docs/tickets/T3-wiring.md
```

(The only `/Applications` left in the clean set is the required macOS fallback in
`tests/staging.ts`.)

## 6. Verification evidence

### 6.1 Typecheck and full suite (normal machine, staging runs)

```console
$ npm run typecheck
> dsh-bridge-mcp@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit
$ npm test
…
ℹ tests 88
ℹ suites 0
ℹ pass 88
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 37731.261875
```

88 = the 57 pre-existing tests + 31 new ones: `tests/config.test.ts` (9),
`tests/host.test.ts` (16 new, 20 total), `tests/staging-resolve.test.ts` (6).

### 6.2 Ladder order and `~` expansion (real call against `dist/`)

The script resolves through the public `resolveHost` with a temp config and temp credentials:

```console
$ node .r1-proof.mjs
1 flag   -> source=flag        host=http://127.0.0.1:3333
2 env    -> source=env         host=http://127.0.0.1:2222
3 config -> source=config-host host=http://127.0.0.1:1111  file=true
4 disc.  -> source=discovery   host=http://127.0.0.1:4444
5 "~/from-config" -> /var/folders/51/yjx5vc5n4k96w5pz383z9gx80000gn/T/r1-proof-1o5Gll/from-config  (expanded=true)
6 bad config -> ConfigError: config file /var/folders/51/yjx5vc5n4k96w5pz383z9gx80000gn/T/r1-proof-1o5Gll/bad.json has unknown key(s) "typo"; allowed keys: url, host, dshHome
```

Line 4 used an injected fake probe and confirm (the same seams the unit tests use), so no host
was contacted. Line 6 shows the loud-error path for an unknown key; the same test covers bad
JSON and non-string values.

### 6.3 Caller-aware discovery error

See the console block in §2. Unit tests assert the same messages without touching the network:
`discovery failure names the platform, every probe tried, and the CLI fix` and
`discovery failure for the MCP server says DSH_BRIDGE_HOST, not --host`.

## 7. Deliberately left for later slices

- **Auth**: the URL-token path (`--url`, `DSH_BRIDGE_URL`, and the config file's `url` token) and
  its precedence over credential minting. R1 accepts `url` and uses its origin; the token is not
  consumed yet. The release contract's auth section is a later slice, as instructed.
- **`doctor` / `setup` / `examples/` / LICENSE / CI / README rewrite / `docs/spec.md` →
  `docs/protocol.md` / tickets → `docs/dev/`.** R1 only touched the sections it owns.
- **Windows sending** remains untested (contract); discovery is best-effort and gated by the
  authenticated `session/list` confirmation.
- The config file is deliberately not documented in an `examples/` file yet; the README/spec
  discovery paragraphs are the interim documentation.
