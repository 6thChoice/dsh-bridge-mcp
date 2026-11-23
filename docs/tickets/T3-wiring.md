# T3 — Wire it into Claude Code and Antigravity, verify end to end

No new core logic. Wiring, documentation, and cross-harness verification.

## Deliverables

- `npm link` produces working `dsh-bridge` and `dsh-bridge-mcp` on PATH (documented, executed).
- `docs/install.md`:
  - Claude Code: `claude mcp add dsh-bridge -- <path>/dsh-bridge-mcp` plus the
    `~/.claude.json` / project `.mcp.json` equivalent, and the CLI-only fallback
    (`dsh-bridge send --cwd <path> --text "..."` from the Bash tool).
  - Antigravity: the MCP server config file location and exact JSON block.
  - Troubleshooting: 401 (restart DSH after credential rotation), 403 (authority mismatch),
    timeout → `result --rpc-id`, multi-instance (`--host`/`--dsh-home`).
- `docs/usage.md`: the three commands, exit codes, JSON contract, and two worked examples
  (hand a task to a DSH session; poll a long handoff).
- A `scripts/verify.mjs` (or documented command block) that a human can run once to prove the
  install: resolve this machine's host, list sessions, and run a `send` against a staging instance.
- A short manual checklist that the human executes in each harness (one round trip each), with the
  exact prompts to type.

## Acceptance criteria

1. `which dsh-bridge dsh-bridge-mcp` resolves after `npm link`; both run from any cwd.
2. From a Claude Code session, calling the MCP tool `dsh_send` with `--cwd` targeting a live DSH
   session returns that session's answer (human-run, recorded in `docs/install.md` results section).
3. Same round trip from Antigravity (human-run, recorded).
4. Every command in `docs/usage.md` executes verbatim; every claimed error code reproduces.
5. No secrets in the repo: the docs never print a real cookie or the credential secret; only the
   scheme and file path.

## Known host facts (verified on this machine, 2026-11-23)

- Claude Code `2.1.261` is on PATH (`claude`). Its user-scope MCP servers live in
  `~/.claude.json` under `mcpServers` (currently empty); `claude mcp add` writes there.
- Antigravity is installed (`/Applications/Antigravity.app`). Its MCP config file is
  `~/.gemini/config/mcp_config.json` — currently an **empty file**, so write a well-formed
  `{"mcpServers": {...}}` object.
- Do not assume a server-name convention beyond the one you document; pick `dsh-bridge` for both.
- Claude Code CLI syntax (verified locally, `claude mcp add --help`):
  `claude mcp add <name> [--scope user] -- <command> [args...]`, env via `-e KEY=value`.
- Antigravity: global config `~/.gemini/config/mcp_config.json`, top-level `mcpServers` object,
  stdio entries `{command, args?, env?, cwd?}`; remote entries use `serverUrl` instead.
  Sources: [Microsoft Learn — Azure MCP in Antigravity](https://learn.microsoft.com/bs-latn-ba/Azure/developer/Azure-mcp-server/get-started/tools/anti-gravity#1),
  [bifrost docs](https://github.com/brokkai/bifrost/blob/6c889183c1b0e81c74aa80f6d362bc547315b99b/docs/src/content/docs/antigravity.md).
  A workspace-scoped alternative is claimed to exist (`.agents/mcp_config.json` in the project
  root) but is **unverified** — document the global file as the supported path and confirm
  empirically during the human round trip; if the IDE rejects the file, say so in the results
  section rather than guessing again.

## Notes

- Keep the docs honest about the two known fragilities: the cookie scheme is internal to DSH
  (a version bump can break it), and a blocking `send` is bounded by the calling harness's own
  tool timeout (hence detach + `result`).

## Result

Implemented by the planning session directly (two subagent attempts died without writing
anything; no partial state existed in the repo or in the harness configs).

### Installed

- `npm link` → `dsh-bridge` and `dsh-bridge-mcp` both on PATH under
  `~/.nvm/versions/node/v24.19.0/bin/`; both run from an unrelated cwd.
- `scripts/verify.mjs` added; a passing run is pasted in `docs/install.md` §1 (live read-only
  round trip + staging send + detach + result).
- Claude Code: registered at user scope, backups at `~/.claude.json.bak-dsh-bridge-*`:
  `claude mcp add --scope user dsh-bridge -e PATH=/usr/bin:/bin:/usr/sbin:/sbin -e DSH_BRIDGE_FROM=claude-code -- /Users/zhouxuancheng/.nvm/versions/node/v24.19.0/bin/node /Users/zhouxuancheng/CodeBase/dsh-bridge/dist/mcp.js`
- Antigravity: `~/.gemini/config/mcp_config.json` written (backup alongside), absolute node +
  absolute `dist/mcp.js`, `env = {PATH, DSH_BRIDGE_FROM=antigravity}`; validated with
  `python3 -m json.tool`.

### Evidence

```console
$ which dsh-bridge dsh-bridge-mcp
/Users/zhouxuancheng/.nvm/versions/node/v24.19.0/bin/dsh-bridge
/Users/zhouxuancheng/.nvm/versions/node/v24.19.0/bin/dsh-bridge-mcp

$ cd /tmp && dsh-bridge sessions --limit 2
session-474d640c-0968-452a-9ee3-5bec233690fa	true	2026-11-23T10:02:52.263Z	跨 harness 向 DeepSeek 会话发消息	/Users/zhouxuancheng/Documents/Agent/deepseek-harness
fe16bfce-65e4-4832-9eee-023953f6272e	false	2026-11-23T08:56:42.978Z	You are an independent code	/Users/zhouxuancheng/Documents/Agent/deepseek-harness

$ node scripts/verify.mjs
── live host: auth + discovery + session/list (read-only)
   host: http://127.0.0.1:49904
   sessions: 3053
── staging instance: send round trip (stub provider, no real model call)
   stdout: "VERIFY-PONG"
   detached rpcId: 90eb72e9-0843-44eb-b07e-2323a5041ca4
   result: status=completed turn=2 toolCalls=0
verify: OK — live auth/list works (3053 sessions) and a staging send returned its own turn's answer.

$ claude mcp list | grep dsh-bridge
dsh-bridge: /Users/zhouxuancheng/.nvm/versions/node/v24.19.0/bin/node /Users/zhouxuancheng/CodeBase/dsh-bridge/dist/mcp.js - ✔ Connected

$ dsh-bridge result --rpc-id deadbeef-0000-0000-0000-000000000000; echo exit=$?
dsh-bridge: rpcId … is not in the send index (…) and no user/message carrying it appears in the tail
of the 50 most recently updated sessions on http://127.0.0.1:49904
exit=1

$ dsh-bridge sessions --title "因子失效" --json | … # 0 rows, exit 0
$ dsh-bridge sessions --limit 5                     # 5 rows, exit 0
```

### The GUI-`PATH` trap (found while wiring, now documented)

Launching the MCP server with a GUI-like empty environment fails at discovery:

```console
$ … | env -i HOME="$HOME" node dist/mcp.js
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"dsh_sessions: cannot
enumerate listening sockets with lsof: Error: spawnSync lsof ENOENT. Pass --host http://127.0.0.1:<port> explicitly."}],"isError":true}}
```

With `PATH=/usr/bin:/bin:/usr/sbin:/sbin` the same call succeeds and auto-discovery finds the host,
so both harness configs carry that `PATH` and need no pinned port. (Follow-up, backlog: the message
says "Pass --host", which is CLI phrasing; over MCP it should name `DSH_BRIDGE_HOST`.)

### Not done here (human steps)

- In-IDE round trip in Antigravity (restart the app, then run `dsh_sessions {limit:3}` and a
  `dsh_send` with text "reply with the single word PONG"); the config is written and JSON-valid but
  the IDE's own loader is the only thing that can confirm it.
- A Claude Code *agent-level* round trip through the MCP tool (registration is proven by the
  health check; the manual prompt is in `docs/install.md` §7).

### Deviations

- `index.md`/`usage.md` examples use placeholder targets, not live sessions; the `send` examples were
  executed against the staging instance with `--host/--dsh-home` swapped, never against a user session.
