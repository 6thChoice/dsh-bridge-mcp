# Install and wire it into other harnesses

`dsh-bridge` runs outside DSH. It needs no DSH plugin and no DSH rebuild; it talks to the
running DSH Web host over its own HTTP/WS API.

## 1. Install (this machine)

```sh
cd ~/CodeBase/dsh-bridge
npm install
npm run build
npm link          # puts dsh-bridge and dsh-bridge-mcp on PATH
```

Verify the install with one command:

```sh
npm run build:tests   # only needed for the staging half of scripts/verify.mjs
node scripts/verify.mjs
```

It does a read-only round trip against the live DSH host and a full `send` round trip against a
disposable staging instance (stub provider — no real model call, no real session touched).
Recorded output of a passing run:

```console
── live host: auth + discovery + session/list (read-only)
   host: http://127.0.0.1:49904
   sessions: 3053
   session-474d640c-…  running=true  跨 harness 向 DeepSeek 会话发消息
── staging instance: send round trip (stub provider, no real model call)
   host: http://127.0.0.1:56740
   session: session-5f04a71a-…
   stdout: "VERIFY-PONG"
   detached rpcId: 90eb72e9-…
   result: status=completed turn=2 toolCalls=0
verify: OK — live auth/list works (3053 sessions) and a staging send returned its own turn's answer.
```

## 2. Claude Code

Registered (user scope) and health-checked on this machine:

```sh
claude mcp add --scope user dsh-bridge \
  -e PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  -e DSH_BRIDGE_FROM=claude-code \
  -- /Users/zhouxuancheng/.nvm/versions/node/v24.19.0/bin/node \
     /Users/zhouxuancheng/CodeBase/dsh-bridge/dist/mcp.js

claude mcp list | grep dsh-bridge
# dsh-bridge: …/node …/dist/mcp.js - ✔ Connected
```

Then, inside a Claude Code session, the tools are `dsh_send`, `dsh_result`, `dsh_sessions`.

CLI-only fallback (no MCP): from the Bash tool,

```sh
dsh-bridge send "summarise where you got to" --cwd ~/Documents/Agent/deepseek-harness --latest
```

## 3. Antigravity

Global config file `~/.gemini/config/mcp_config.json` (back it up first; an empty file is a valid
starting point). Write:

```json
{
  "mcpServers": {
    "dsh-bridge": {
      "command": "/Users/zhouxuancheng/.nvm/versions/node/v24.19.0/bin/node",
      "args": ["/Users/zhouxuancheng/CodeBase/dsh-bridge/dist/mcp.js"],
      "env": {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "DSH_BRIDGE_FROM": "antigravity"
      }
    }
  }
}
```

Restart Antigravity (or reload its MCP servers) after editing.

A workspace-scoped `.agents/mcp_config.json` is reported to exist in some Antigravity versions but
is unverified here; the global file above is the supported path.

## 4. Why the absolute paths and the explicit `PATH`

GUI apps do not inherit your shell `PATH`. Two failures this avoids, both observed on this machine:

1. **`node` not found** — a bare `dsh-bridge-mcp` command or a bare `node` in the config fails when
   the IDE was launched from Finder/Dock, because it only sees nvm's node through your shell rc.
2. **host discovery fails** — discovery enumerates loopback listeners with `lsof`; with an empty
   `PATH` the process cannot spawn it and the tool reports
   `cannot enumerate listening sockets with lsof: spawnSync lsof ENOENT`. Adding the system
   `PATH` (or pinning `DSH_BRIDGE_HOST`) fixes it.

Pinning `DSH_BRIDGE_HOST=http://127.0.0.1:<port>` also works, but the port can change when DSH
restarts; the `PATH` form keeps auto-discovery alive and needs no maintenance.

## 5. Machine-level facts

| Item | Value on this machine |
|---|---|
| Live host | `http://127.0.0.1:49904` (DSH desktop app, `dsh` 0.1.5-rc.2) |
| Credentials | `~/.dsh/.credentials.yaml` → `client-connection/browser-session` |
| Send index | `~/.dsh/dsh-bridge/sends.jsonl` (append-only, shared by CLI and MCP) |
| Staging binary for tests | `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` (0.2.1-rc.2) |

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| HTTP **401** on every call | the cookie secret in `~/.dsh/.credentials.yaml` rotated after DSH started, or `DSH_HOME` points at another install | restart DSH, then retry; or pass the right `--dsh-home` / `DSH_HOME` |
| HTTP **403** | the authority in the request does not match the credential's authority, or `Host` is not loopback/trusted | address the host exactly as DSH prints it (`127.0.0.1:<port>`, not `localhost`) |
| `cannot enumerate listening sockets with lsof` | empty `PATH` (GUI launch) | add `PATH` to the MCP `env`, or pin `DSH_BRIDGE_HOST` |
| `credentials missing` | `~/.dsh/.credentials.yaml` has no `client-connection/browser-session` record | start DSH once with a Web host so the record is minted |
| exit 2, `status: "timeout"` | the turn outlived `--timeout` | finish it with `dsh-bridge result --rpc-id <id> --wait`, or use `--detach` up front |
| target matches many sessions | selector too loose | add `--cwd`, a longer id prefix, or `--title` |
| multiple DSH installs, wrong sessions | auto-discovery picked another host | pass `--host` (CLI) / `DSH_BRIDGE_HOST` (MCP) |
| MCP tool missing in the IDE | config not reloaded, or the command path is wrong | restart the IDE; run the configured command by hand with a JSON-RPC line on stdin |

## 7. Manual verification (human steps)

Claude Code — in any project: ask the agent to run `dsh_sessions` with `limit: 3`, then
`dsh_send` targeting one of those sessions with the text `reply with the single word PONG`.
Expect a tool result whose text is that session's answer.

Antigravity — after restarting, in an Agent chat: run the same two calls. If the tools are absent,
check the IDE's MCP log and confirm `~/.gemini/config/mcp_config.json` is the file it reads.
