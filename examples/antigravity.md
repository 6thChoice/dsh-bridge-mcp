# Antigravity

`dsh-bridge-mcp` is a stdio MCP server. Antigravity starts it, and the tools `dsh_send`,
`dsh_result`, `dsh_sessions` appear in an agent chat.

**Verified:** `~/.gemini/config/mcp_config.json` with this exact `mcpServers.dsh-bridge` entry is
what this machine already runs, and `setup antigravity --write` merges it with a timestamped
`.bak-dsh-bridge-mcp-*` backup (tested against a temp `HOME`); **not verified:** relaunching
Antigravity to watch the connection come up.

## Where it goes

Global config: `~/.gemini/config/mcp_config.json`. Back it up first; an empty `{}` is a valid
starting point. The block goes under the top-level `mcpServers` key:

```json
{
  "mcpServers": {
    "dsh-bridge": {
      "command": "<absolute-path-to-node>",
      "args": ["<absolute-path-to-dist>/mcp.js"],
      "env": {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "DSH_BRIDGE_FROM": "antigravity"
      }
    }
  }
}
```

GUI apps do not inherit your shell `PATH` (see `docs/install.md` §4): the explicit `PATH` is what
lets both `node` and the discovery probe (`lsof`) spawn. Both paths must be absolute for the same
reason — fill them with `command -v node` and the checkout's `dist/mcp.js`.

From npm, replace the two path fields with:

```json
"command": "npx",
"args": ["-y", "dsh-bridge-mcp"]
```

Then restart Antigravity (or reload its MCP servers) and run `dsh_sessions` with `limit: 3`.

`dsh-bridge setup antigravity` prints this block generated with the real paths; add `--write` to
merge it automatically (`--force` replaces an existing `dsh-bridge` entry).
