# Claude Code

`dsh-bridge-mcp` is a stdio MCP server. Claude Code starts it, and the tools `dsh_send`,
`dsh_result`, `dsh_sessions` appear in the session.

**Verified:** `dsh-bridge setup claude-code --write` runs exactly the `claude mcp add` command below
(exercised against a stand-in `claude` executable) and the JSON block is the entry that command
writes; **not verified:** a live Claude Code session calling the tools from this checkout.

## Where it goes

- User scope: `~/.claude.json`, under `mcpServers`.
- Project scope: `.mcp.json` in the project root (commit it if the whole team should see the server).

```json
{
  "mcpServers": {
    "dsh-bridge": {
      "command": "<absolute-path-to-node>",
      "args": ["<absolute-path-to-dist>/mcp.js"],
      "env": {
        "DSH_BRIDGE_FROM": "claude-code"
      }
    }
  }
}
```

Or let Claude Code write it (exactly what `--write` delegates to):

```sh
claude mcp add --scope user dsh-bridge \
  -e DSH_BRIDGE_FROM=claude-code \
  -- "$(command -v node)" "$(pwd)/dist/mcp.js"

claude mcp list | grep dsh-bridge
```

From npm instead of a checkout:

```json
{
  "mcpServers": {
    "dsh-bridge": {
      "command": "npx",
      "args": ["-y", "dsh-bridge-mcp"],
      "env": {
        "DSH_BRIDGE_FROM": "claude-code"
      }
    }
  }
}
```

`-y` only suppresses npx's "Ok to proceed?" prompt, which a GUI-started process cannot answer.

## First call

Ask Claude Code to call `dsh_sessions` with `limit: 3`, then `dsh_send` to one of those session ids
with the text `reply with the single word PONG`. The tool result is that session's answer, not a
delivery acknowledgement.
