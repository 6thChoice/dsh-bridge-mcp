# Codex CLI

`dsh-bridge-mcp` is a stdio MCP server. Codex starts it per session and exposes `dsh_send`,
`dsh_result`, `dsh_sessions`.

**Verified:** the TOML shape (`[mcp_servers.<name>]` with `command`/`args` and an `.env`
sub-table) follows OpenAI's MCP configuration and `dsh-bridge setup codex` emits it; **not
verified:** a live Codex run (no Codex install on the machine this was written on).

## Where it goes

`~/.codex/config.toml` (the same file that holds Codex's other settings). Append:

```toml
[mcp_servers.dsh-bridge]
command = "<absolute-path-to-node>"
args = ["<absolute-path-to-dist>/mcp.js"]

[mcp_servers.dsh-bridge.env]
DSH_BRIDGE_FROM = "codex"
```

From npm instead of a checkout:

```toml
[mcp_servers.dsh-bridge]
command = "npx"
args = ["-y", "dsh-bridge-mcp"]

[mcp_servers.dsh-bridge.env]
DSH_BRIDGE_FROM = "codex"
```

No `PATH` entry is needed: Codex is a terminal program and inherits your shell environment. If you
launch it from a GUI launcher and discovery fails with `cannot run: spawnSync … ENOENT`, add the
system `PATH` from `docs/install.md` §4 to the env table.

Restart Codex, then call `dsh_sessions` with `limit: 3`, and `dsh_send` to one of the ids.

`dsh-bridge setup codex` prints this block with the real paths (print-only: `--write` does not
support Codex).
