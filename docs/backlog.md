# Backlog

Findings the independent review (2026-11-23) rated P2/P3, plus follow-ups found while wiring.
P0/P1 were fixed in place; these are deliberately not merge gates. Each item names the code site
and the smallest correct fix, so it can be picked up cold.

## P2 — should fix, not release-blocking

| # | Where | Problem | Smallest fix |
|---|---|---|---|
| P2-1 | `src/run.ts:340-344` | `send --steer` into a long turn fails with `ProtocolError` (exit 1) after the prompt was already delivered: the follow snapshot is a 50-*message* tail window, so a turn with ≳25 steps has its `turn/start` outside it and `currentTurn` stays `undefined`. | When `currentTurn` is undefined at match time, page history back to the turn start (the routine `result` already uses) or re-`follow` with a larger window before giving up. |
| P2-2 | `src/result.ts:191-203, 240-273` | Latent wrong-turn read-back: `turnStartFor` accepts any `turn/start` at or before the message, so if a future host admits `user/message` before its own `turn/start`, reconstruction adopts the previous turn — already ended — and returns that answer with exit 0. Unreachable on 0.2.1 (ordering verified over 373/373 messages), but the safety is accidental. | Treat a turn as ended only when `turn/end.seq > matched user/message.seq`, and stop paging only when no `turn/end` sits between the last `turn/start` and the message. Add a unit test on the ordering invariant. |
| P2-3 | `src/result.ts:409, 420-426` | `pending` conflates three states: genuinely queued, dropped before admission (host `cancel()` clears the inbox), and older than the 50×200-message read window. The latter two are terminal but report `pending`/exit 0 forever. | Propagate `hasMore`/exhaustion out of `loadTurnHistory` and report `not-found`/`dropped` instead of `pending`. Until then, `result ... pending` is not proof a turn is still running. |
| P2-4 | `src/result.ts:155` | Index-less scan starts from `session/list`'s `projections.asOfSeq`; if that projection lags, the just-sent message is never reached and a message that exists reports `ResultNotFound` (exit 1). | Retry once after a fresh `session/list`, and phrase the error as "not found in the tail", not "does not exist". |

## P3 — nits

| # | Where | Problem |
|---|---|---|
| P3-1 | `src/run.ts:512` | Timeout hint asserts the turn "is still pending"; false when the prompt was never admitted. Say "may still be pending". |
| P3-2 | `src/run.ts:443, 322` | The deadline is measured from before `listSessions` + follow open, so `--timeout 1` can expire before the prompt is even sent. Start it after prompt acceptance, or document it. |
| P3-3 | `src/run.ts:471` | A client-side `session/prompt` timeout (30 s, `src/host.ts:16`) that fires *after* the host accepted leaves exit 1 and no index row, while the turn runs. Only the bounded scan can recover it. |
| P3-4 | `src/result.ts:257, 365, 395` | Reads the whole `sends.jsonl` three times per `result`; growth is unbounded (append-only is mandated). Cap or rotate eventually. |
| P3-5 | `src/cli.ts:234-244` | The "turn ended with status=…" stderr note exists for `send` only; `result` gives exit 3 with no explanation. |
| P3-6 | `src/result.ts:301` | `durationMs` for `pending` is wall time since the message, not a turn duration. |
| P3-7 | `src/host.ts` (discovery error) | The `lsof` failure message says "Pass `--host`", which is CLI phrasing; over MCP the actionable advice is `DSH_BRIDGE_HOST`. |
| P3-8 | `src/client.ts` (follow) | No reconnect: one dropped socket costs the answer (recoverable via `result`). Add a single bounded re-follow if it proves common. |
| P3-9 | `src/result.ts` (baseline) | The follow baseline cursor is recorded but never read, so nothing detects an event skipped between the snapshot and the first live frame. Cheap assertion: first live frame's `seq === cursor + 1`. |
