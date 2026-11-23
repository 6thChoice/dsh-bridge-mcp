# Cursor

`dsh-bridge-mcp` is a stdio MCP server. Cursor starts it and exposes `dsh_send`, `dsh_result`,
`dsh_sessions` in Agent chats.

**Verified:** the JSON shape (`mcpServers` with `command`/`args`/`env`) is Cursor's documented
`mcp.json` format and `dsh-bridge setup cursor` emits it; **not verified:** a live Cursor run (no
Cursor install on the machine this was written on).

## Where it goes

- Global: `~/.cursor/mcp.json`.
- Project: `.cursor/mcp.json` in the project root (commit it to share).

```json
{
  "mcpServers": {
    "dsh-bridge": {
      "command": "<absolute-path-to-node>",
      "args": ["<absolute-path-to-dist>/mcp.js"],
      "env": {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "DSH_BRIDGE_FROM": "cursor"
      }
    }
  }
}
```

Cursor is a GUI app: the explicit `PATH` is what lets `node` and the discovery probe (`lsof`)
spawn when Cursor was started from the Dock (see `docs/install.md` §4). Keep both paths absolute.

From npm, use:

```json
"command": "npx",
"args": ["-y", "dsh-bridge-mcp"]
```

Restart Cursor (or reload its MCP servers) and ask the agent to call `dsh_sessions` with
`limit: 3`.

`dsh-bridge setup cursor` prints this block with the real paths; Cursor is print-only, so paste it
yourself (`--write` supports only `claude-code` and `antigravity`).
