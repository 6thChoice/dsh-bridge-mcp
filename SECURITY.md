# Security model

`dsh-bridge-mcp` talks to a running DeepSeek Harness (DSH) Web host on behalf of another agent
harness. Understanding what it can reach matters more than most tools, because the host it talks to
can run shell commands on your machine.

## What the tool can do

Anything the authenticated DSH Web client can do: list sessions, read session history, and **send
prompts to a session** — which can make that session's agent run tools. Sending a prompt is
therefore as powerful as typing into the DSH composer yourself.

It cannot read files through DSH beyond what a session transcript already contains, and it never
writes to the DSH home except an append-only send index at `$DSH_HOME/dsh-bridge/sends.jsonl`
(rpcIds, session ids, sender labels, timestamps — no prompt text, no results).

## How it authenticates (two paths)

1. **URL token** (`--url` / `DSH_BRIDGE_URL`): the one-shot launch URL that `dsh web` prints. The
   tool exchanges it for DSH's browser cookie exactly as a browser does. The token is single-use
   for identity establishment; the resulting cookie is valid for up to 30 days and is held **in
   memory only**, never written to disk.
2. **Credential minting** (`$DSH_HOME/.credentials.yaml`): the tool reads DSH's own
   `client-connection/browser-session` secret and signs a cookie for the target authority. This
   requires read access to that file — which already means read access to DSH's credential store —
   and exists because the desktop app never prints a launch URL.

Both paths produce the same thing: a browser-equivalent session for the DSH host. There is no
privilege escalation beyond what a browser tab pointing at that host would have.

`doctor` reports which path was used. No command prints the secret, the cookie, or the token; the
`--json` output does not contain them either.

## Revoking access

- Delete `~/.dsh/.credentials.yaml`'s `client-connection/browser-session` record and restart DSH:
  every minted cookie becomes invalid.
- The tool stores no cookie, so nothing else needs cleaning up on the bridge side.

## Network exposure

- Loopback only by default. The tool refuses non-loopback authorities unless the host itself trusts
  them (`--trusted-host` on `dsh web`) — DSH enforces that, not this tool.
- Do not bridge to a host exposed on a plaintext public interface: the cookie is a bearer credential
  and DSH's shipped server speaks HTTP. Put TLS in front (`dsh web --tls-cert/--tls-key`) or a
  tunnel you control.
- `dsh-bridge` never phones home: no telemetry, no update check, no network calls other than the
  DSH host you configured.

## Reporting a vulnerability

Open a GitHub security advisory on
[6thChoice/dsh-bridge-mcp](https://github.com/6thChoice/dsh-bridge-mcp/security/advisories) rather
than a public issue if the report involves credential handling, authentication bypass, or the
ability to reach a host the caller did not configure. Everything else can be a normal issue with
`dsh-bridge doctor` output attached (it contains no secrets — please double-check before pasting).
