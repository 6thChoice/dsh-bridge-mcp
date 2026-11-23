# T2 — MCP stdio shell

Implements §10 of [`../spec.md`](../spec.md) on top of T1's core module.

## Deliverables

- `src/mcp.ts` — newline-delimited JSON-RPC 2.0 over stdio. Handles `initialize`, `ping`,
  `tools/list`, `tools/call`; ignores notifications (`notifications/initialized`);
  unknown method → `-32601`; tool-level failures → `isError: true` result, never a transport error.
- Bin `dsh-bridge-mcp` wired in `package.json` → `dist/mcp.js`.
- Three tools with exact JSON Schemas: `dsh_send`, `dsh_result`, `dsh_sessions` (fields per §10).
- `tests/mcp.test.ts` — spawn the bin, drive it over stdio: initialize handshake, tools/list
  schemas, one `dsh_sessions` call against the live host (read-only), one `dsh_send` against the
  staging instance, an unknown-method error, and a tool failure (`isError`).

## Acceptance criteria

1. `initialize` returns server info `{name:"dsh-bridge", version:<package version>}` and
   `capabilities.tools`.
2. `tools/list` returns exactly three tools with valid JSON Schemas; no extra tools.
3. `dsh_send` against the staging instance returns `content[0].text` equal to the stub's assistant
   text, `structuredContent.status === "completed"`, `isError` absent.
4. `dsh_send` with a bogus target returns `isError: true` and a message naming the ambiguity/failure,
   exit stays 0 (the server keeps serving).
5. `dsh_result` for a detached send works; `dsh_sessions` returns rows.
6. Protocol is line-delimited, no stdout pollution (all diagnostics on stderr);
   `node dist/mcp.js < /dev/null` exits 0 without hanging.
7. `npm run typecheck` clean, all tests green.

## Notes

- Reuse T1's core verbatim; do not duplicate auth/resolve/await logic.
- MCP default `timeoutSeconds` is 3600 unless the caller passes one.
- `from` defaults to `$DSH_BRIDGE_FROM` or `mcp`.
