# Contributing

Thanks for looking. This is a small, deliberately boring tool: one client, one contract, few moving
parts. The most useful contributions are bug reports with `dsh-bridge doctor` output, new harness
wiring examples, and fixes for DSH version drift.

## Development

```sh
git clone https://github.com/6thChoice/dsh-bridge-mcp
cd dsh-bridge-mcp
npm install
npm run build
npm run typecheck
npm test
```

- Node **>= 22.19**; zero runtime dependencies, and we would like to keep it that way. A PR that
  adds a runtime dependency needs a strong argument in its description.
- `npm test` builds, typechecks the tests, then runs unit tests plus staging integration tests. The
  staging tests spawn a disposable `dsh web` with a temp `DSH_HOME` and a local stub model provider
  — no real model call, no real session touched. They **self-skip** when no `dsh` binary can be
  found, so the suite stays green on a clean machine. Point it at a binary explicitly with
  `DSH_BIN=/path/to/dsh npm test`.
- Never test against a real user session. If you need an end-to-end check, use the staging harness
  in `tests/staging.ts`.
- Never print or log credential or cookie values — including in test failure messages.

## Contract discipline

`docs/protocol.md` is the binding wire contract (verified against a real DSH host), and
`docs/release.md` records product decisions. If your change contradicts either, change the document
in the same PR and say why in the description. Silent drift is the main way this tool can break: it
depends on DSH internals that can move between releases.

If you find that a newer DSH changed a shape, the fastest useful PR is: a failing staging test that
demonstrates it, the minimal fix, and the updated `docs/protocol.md` section.

## Commits and PRs

- Small, logical commits; `type(scope): summary` in the subject, imperative mood.
- One concern per PR. Behaviour changes need a test that fails without the change.
- Run `npm run typecheck && npm test` before pushing; CI runs the same on Node 22 and 24.

## Adding a harness to `examples/`

Copy the closest existing file, use placeholders (`<absolute-path-to-node>`) rather than your own
paths, and prefer the `npx dsh-bridge-mcp` form where the harness supports it. Say in a comment what
you verified and what you did not — an untested config presented as tested is worse than a missing
one.

## Scope

The tool is a **client**. It does not install anything into DSH, does not modify DSH, and does not
attempt to be a general agent-to-agent protocol. Feature requests along those lines are better
answered by a DSH plugin (there is an existing one; see the README's comparison).
