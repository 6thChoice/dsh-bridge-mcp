# Continue

`dsh-bridge-mcp` is a stdio MCP server. Continue starts it in agent mode and exposes `dsh_send`,
`dsh_result`, `dsh_sessions`.

**Verified:** Continue documents MCP servers as a YAML **list** under `mcpServers` and
`dsh-bridge setup continue` emits that list entry; **not verified:** a live Continue run (no
Continue install on the machine this was written on).

## Where it goes

User config: `~/.continue/config.yaml`, under the top-level `mcpServers:` list. Merge this list
item into the existing list:

```yaml
mcpServers:
  - name: dsh-bridge
    command: "<absolute-path-to-node>"
    args:
      - "<absolute-path-to-dist>/mcp.js"
    env:
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin"
      DSH_BRIDGE_FROM: "continue"
```

Workspace alternative: put exactly that `mcpServers` list in
`.continue/mcpServers/dsh-bridge.yaml` and add the standalone-file header
(`name: dsh-bridge`, `version: 0.0.1`, `schema: v1`).

Continue also reads JSON MCP files dropped into `.continue/mcpServers/`, so the block from
`examples/cursor.md` works there too.

From npm, use `command: "npx"` and `args: ["-y", "dsh-bridge-mcp"]`.

Continue is a GUI/IDE extension, hence the explicit `PATH` from `docs/install.md` §4; it only
affects the spawned server, not your terminal.

Reload Continue, switch to agent mode, then call `dsh_sessions` with `limit: 3`.

`dsh-bridge setup continue` prints this block with the real paths; Continue is print-only
(`--write` supports only `claude-code` and `antigravity`).
