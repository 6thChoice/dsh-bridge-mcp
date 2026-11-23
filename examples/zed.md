# Zed

`dsh-bridge-mcp` is a stdio MCP server. Zed starts it and exposes `dsh_send`, `dsh_result`,
`dsh_sessions` in the Agent Panel.

**Verified:** current Zed docs configure custom servers as `context_servers` entries with
`command`/`args`/`env`, and `dsh-bridge setup zed` emits that shape; **not verified:** a live Zed
run (no Zed install on the machine this was written on).

## Where it goes

Zed's `settings.json` — open it with the `zed: open settings file` command (or Settings → AI → MCP
Servers → Add Server → Add Local Server, which writes the same entry). Merge:

```json
{
  "context_servers": {
    "dsh-bridge": {
      "command": "<absolute-path-to-node>",
      "args": ["<absolute-path-to-dist>/mcp.js"],
      "env": {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "DSH_BRIDGE_FROM": "zed"
      }
    }
  }
}
```

Older Zed builds also asked for `"source": "custom"` inside the entry. Current documentation omits
it; add it only if your Zed version refuses the entry.

Zed is a GUI app: the explicit `PATH` is the fix from `docs/install.md` §4.

From npm, use `"command": "npx"` and `"args": ["-y", "dsh-bridge-mcp"]`.

Check Settings → AI → MCP Servers for a green "Server is active" dot, then call `dsh_sessions` with
`limit: 3` in the Agent Panel.

`dsh-bridge setup zed` prints this block with the real paths; Zed is print-only (`--write` supports
only `claude-code` and `antigravity`).
