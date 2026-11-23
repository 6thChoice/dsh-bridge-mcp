# Install and wiring

`dsh-bridge-mcp` runs outside DSH: nothing is added to a DSH profile, no plugin is installed, and no
part of DSH is modified. It talks to a running DSH **Web host** over that host's own HTTP/WS surface,
using a browser-equivalent session.

## 1. Install

Not published to npm yet, so install from source:

```sh
git clone https://github.com/6thChoice/dsh-bridge-mcp
cd dsh-bridge-mcp && npm install && npm link
```

`npm install` alone is enough: the package's `prepare` script builds `dist/`. `npm link` only adds the
`dsh-bridge` and `dsh-bridge-mcp` commands to your `PATH`; every command also works as
`node dist/cli.js …` from inside the checkout, and `setup` emits absolute paths either way.

Without a clone, `npx` can run the repository copy — `--package` is required because the package
ships two binaries and a bare `npx <spec>` picks neither:

```sh
npx -y --package github:6thChoice/dsh-bridge-mcp dsh-bridge doctor
```

Node **>= 22.19**. Automatic host discovery uses `lsof` (macOS), `ss`/`lsof` (Linux) or
`Get-NetTCPConnection` (Windows); if none is available, pass the host explicitly.

## 2. First run: `doctor`

```sh
dsh-bridge doctor
```

It reports, and this is the whole troubleshooting story:

- which host it resolved, and how (`--host`, `DSH_BRIDGE_HOST`, config file, platform discovery);
- which authentication path produced the session (`url-token` or `credentials`);
- whether an authenticated `session/list` was accepted, its latency, and the visible session count;
- for every failing check, the concrete next step.

Exit code is `0` only when it could actually send. `--json` gives the same information as one stable
object (see [`usage.md`](usage.md)).

## 3. Authentication, and what you have to do (often nothing)

| Path | When it applies | What the user does |
|---|---|---|
| **url-token** | you pass `--url` / set `DSH_BRIDGE_URL` (or put `url` with a token in the config file) | copy the URL that `dsh web` prints: `dsh web: http://127.0.0.1:<port>/?token=…` |
| **credentials** | otherwise (including the desktop app) | nothing — the tool reads `$DSH_HOME/.credentials.yaml` and signs the browser cookie |

The URL token wins when both are available. Neither the token nor the cookie is ever written to disk
or printed. For a remote host you generally need the url-token path, because the credential record of
a different machine is not available to you.

The token is per-process and changes when DSH restarts. If a stored URL goes stale, `doctor` says so
(HTTP 401 while expecting a 303) — copy the current URL again.

### Optional config file

`${XDG_CONFIG_HOME:-~/.config}/dsh-bridge/config.json`:

```json
{
  "url": "http://127.0.0.1:49904/?token=…",
  "host": "http://127.0.0.1:49904",
  "dshHome": "~/.dsh"
}
```

All keys are optional. `url` (with a token) selects the url-token path; `host` alone selects
credentials; `dshHome` points at a non-default DSH home. Unknown keys are an error rather than being
ignored, so a typo cannot silently change behaviour.

## 4. Wire it into a harness

`setup` prints a configuration block generated from **the machine running it**: the absolute `node`
binary plus the resolved `dist/mcp.js`, so it works today without a published package. (Only when you
ran the tool through `npx` — no stable install path exists — does it emit the
`npx -y --package github:6thChoice/dsh-bridge-mcp` form instead.)

```sh
dsh-bridge setup claude-code      # print only
dsh-bridge setup claude-code --write   # apply it
```

| harness | output form | `--write` |
|---|---|---|
| `claude-code` | `claude mcp add …` command + JSON | yes (runs `claude mcp add --scope user`) |
| `antigravity` | `mcpServers` JSON | yes (merges into `~/.gemini/config/mcp_config.json`, timestamped backup, refuses to clobber without `--force`) |
| `cursor`, `cline`, `continue`, `zed`, `codex` | that harness's own format (JSON / YAML / TOML) | no — print only |
| `raw` | the plain JSON block | no |

Ready-made copies for each live in [`../examples/`](../examples/), including
[`remote-host.md`](../examples/remote-host.md) and [`cli-only.md`](../examples/cli-only.md).

## 5. Why absolute paths and an explicit `PATH`

GUI-launched harnesses do not inherit your shell `PATH`. Two failures this avoids, both observed in
practice:

1. **`node` not found** — a bare `dsh-bridge-mcp` command or a bare `node` fails when the IDE was
   started from a launcher (Finder, Dock, a desktop file) that only knows the system path.
2. **host discovery fails** — discovery enumerates loopback listeners; with an empty `PATH` it cannot
   spawn its probe and reports that it could not enumerate sockets. `setup` therefore emits
   `PATH=/usr/bin:/bin:/usr/sbin:/sbin` (or the platform equivalent) for GUI harnesses.

Pinning `DSH_BRIDGE_HOST=http://127.0.0.1:<port>` also works, but the port can change when DSH
restarts. Supplying the `PATH` keeps automatic discovery alive and needs no maintenance.

## 6. Verifying a source checkout end to end

```sh
npm run build && npm run build:tests
node scripts/verify.mjs
```

It performs a read-only round trip against the live host plus a full `send` round trip against a
throwaway staging instance (temp `DSH_HOME`, local stub model provider — no real model call, no real
session touched), so you can prove an install without spending a token or disturbing a session.

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| HTTP **401** on every call | the cookie or the credential secret rotated after DSH started | restart DSH, then retry; with the url-token path, copy the freshly printed URL |
| non-303 while expecting a redirect | the launch URL is stale, or the host is not a DSH Web host | re-copy the URL; confirm the origin with `doctor` |
| HTTP **403** | the authority does not match what the host trusts | address the host exactly as it prints it (`127.0.0.1:<port>`, not `localhost`) |
| `cannot enumerate listening sockets` | empty `PATH` under a GUI launch | add `PATH` to the MCP `env`, or pin `DSH_BRIDGE_HOST` |
| no credentials found | `$DSH_HOME/.credentials.yaml` has no `client-connection/browser-session` record | start DSH once with its Web host so the record is minted, or use the url-token path |
| exit 2, `status: "timeout"` | the turn outlived `--timeout` | finish it with `dsh-bridge result --rpc-id <id> --wait`, or use `--detach` up front |
| target matches many sessions | selector too loose | add `--cwd`, a longer id prefix, or `--title` |
| wrong sessions listed (several DSH installs) | auto-discovery picked another host | pass `--host` (CLI) / `DSH_BRIDGE_HOST` (MCP), or set `dshHome` in the config file |
| MCP tool missing in the IDE | config not reloaded, or command path wrong | restart the IDE; run the configured command by hand with a JSON-RPC line on stdin |

## 8. Manual check in each harness

In a Claude Code session, ask the agent to run `dsh_sessions` with `limit: 3`, then `dsh_send`
targeting one of those sessions with `reply with the single word PONG`. Repeat in Antigravity once
its config is in place. If the tools are absent, check that harness's MCP log and confirm the config
file it actually reads.
