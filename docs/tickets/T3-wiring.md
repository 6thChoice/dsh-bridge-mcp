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

## Notes

- Keep the docs honest about the two known fragilities: the cookie scheme is internal to DSH
  (a version bump can break it), and a blocking `send` is bounded by the calling harness's own
  tool timeout (hence detach + `result`).
