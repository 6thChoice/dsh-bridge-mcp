# Cline

`dsh-bridge-mcp` is a stdio MCP server. The Cline extension starts it and exposes `dsh_send`,
`dsh_result`, `dsh_sessions` in its chat.

**Verified:** the JSON shape (`mcpServers` with `command`/`args`/`env` plus `disabled` and
`autoApprove`) follows Cline's MCP settings and `dsh-bridge setup cline` emits it; **not verified:**
a live Cline run (no Cline install on the machine this was written on).

## Where it goes

The MCP settings file is `cline_mcp_settings.json`:

- Cline CLI: `~/.cline/data/settings/cline_mcp_settings.json` (`CLINE_MCP_SETTINGS_PATH` overrides
  the directory).
- VS Code extension: the same file under VS Code's `globalStorage/saoudrizwan.claude-dev/settings/`
  — macOS `~/Library/Application Support/Code/User/…`, Linux `~/.config/Code/User/…`, Windows
  `%APPDATA%\Code\User\…`.
- In the UI: Cline → MCP Servers → Configure MCP Servers opens the same file.

Merge this under `mcpServers`:

```json
{
  "mcpServers": {
    "dsh-bridge": {
      "command": "<absolute-path-to-node>",
      "args": ["<absolute-path-to-dist>/mcp.js"],
      "env": {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "DSH_BRIDGE_FROM": "cline"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

`autoApprove: []` keeps every tool call behind Cline's approval prompt; add tool names there only
if you want the bridge to run unattended. The explicit `PATH` is the GUI-launch fix from
`docs/install.md` §4.

From npm, use `"command": "npx"` and `"args": ["-y", "dsh-bridge-mcp"]`.

Reload Cline's servers, then call `dsh_sessions` with `limit: 3`.

`dsh-bridge setup cline` prints this block with the real paths; Cline is print-only (`--write`
supports only `claude-code` and `antigravity`).
