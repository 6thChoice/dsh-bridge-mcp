# CLI only (no MCP)

Every MCP tool is a thin shell over the `dsh-bridge` command, so any harness with a shell/Bash tool
can use the CLI directly — no MCP handshake, no config file, no server process.

**Verified:** every command below was run against the live host or a staged `dsh web` (see
`docs/dev/R2-auth-and-dx.md`); **not verified:** non-POSIX shells (Windows `cmd`/PowerShell quoting).

## From an agent's Bash tool

```sh
dsh-bridge sessions --limit 5
dsh-bridge sessions --cwd <path-to-project> --json

# One message in, that turn's answer out (stdout is only the text):
dsh-bridge send "summarise where you got to" --cwd <path-to-project> --latest

# Long job: detach, read the verdict later, even after a reboot:
rpc=$(dsh-bridge send "run the full backtest and report IC" --cwd <path-to-project> --latest --detach)
dsh-bridge result --rpc-id "$rpc" --wait --timeout 600

# One-screen connectivity/auth check; exit 0 only when a send can succeed:
dsh-bridge doctor
dsh-bridge doctor --json
```

Exit codes are the contract: `0` completed/pending, `2` timeout, `3` turn error/cancelled, `1`
local error. `send --json` and `result --json` print exactly one JSON object.

## Auth without an MCP config

On a machine with DSH (or with `DSH_HOME` pointed at its home), the CLI mints the browser cookie
from `$DSH_HOME/.credentials.yaml` — zero setup. For a remote DSH, pass the URL it printed:

```sh
dsh-bridge send "ping" --url "http://127.0.0.1:<port>/?token=<token>" \
  --cwd <path-to-session-cwd> --latest
```

The URL token wins over the credentials file when both are available.

## Install

```sh
npm i -g dsh-bridge-mcp     # then `dsh-bridge …` and `dsh-bridge-mcp` are on PATH
```

From a checkout, `npm install && npm run build`, then `node <absolute-path-to-dist>/cli.js …` or put
`dsh-bridge` on PATH with `npm link`. `DSH_BRIDGE_FROM` (default `cli`) labels the visible
`[via <name>] ` prefix; `--from <name>` overrides it per call.
