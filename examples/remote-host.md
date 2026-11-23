# A remote DSH host (URL-token path)

DSH Web binds loopback, so "remote" means: forward the remote host's port over SSH (or any tunnel)
and use the launch URL the remote `dsh web` printed, with the port rewritten to your local forward.

On the DSH machine:

```sh
dsh web --no-open --port 0
# dsh web: http://127.0.0.1:61234/?token=<token>
```

On the calling machine:

```sh
ssh -N -L 61234:127.0.0.1:61234 <user>@<dsh-machine>
```

Then drive it with that URL — no `~/.dsh` credentials and no DSH install on the caller:

```sh
dsh-bridge doctor --url "http://127.0.0.1:61234/?token=<token>"
dsh-bridge send "where did you get to on the ingest?" \
  --url "http://127.0.0.1:61234/?token=<token>" \
  --cwd <path-to-session-cwd-on-the-dsh-machine> --latest
```

For an MCP server, put the URL in its environment instead of every call:

```json
{
  "mcpServers": {
    "dsh-bridge": {
      "command": "npx",
      "args": ["-y", "dsh-bridge-mcp"],
      "env": {
        "DSH_BRIDGE_URL": "http://127.0.0.1:61234/?token=<token>",
        "DSH_BRIDGE_FROM": "remote"
      }
    }
  }
}
```

The config file (`${XDG_CONFIG_HOME:-~/.config}/dsh-bridge/config.json`) can hold the same URL as
`"url"`; its token is used exactly like `--url`, but a `--url`/`DSH_BRIDGE_URL` always wins.

Rules the bridge enforces on this path:

- the URL is exchanged with one `GET` (`redirect: 'manual'`) and only `303` + `Set-Cookie` is
  accepted — no other status and no redirect is followed, so the token cannot be bounced elsewhere;
- the resulting cookie is used for that origin only and lives **in memory**: nothing is written to
  disk and `--json`/errors/logs never contain the token or the cookie;
- `--url` and `--host` must name the same origin; a mismatch is an error rather than a guess;
- if the exchange fails, the failure is reported — there is no fallback to credential minting;
- when DSH restarts, the port and the token change: re-copy the printed URL.

**Verified:** the URL-token path completed a real `send` against a staged `dsh web` with
`DSH_HOME` pointed at a non-existent directory (see `docs/dev/R2-auth-and-dx.md`); **not verified:**
this exact SSH forwarding against a second physical machine.
