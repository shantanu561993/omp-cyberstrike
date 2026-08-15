# session_bot

> Background session-guardian bot: keeps an exported role session alive, probing and re-authenticating.

## Source
- Entry: `packages/coding-agent/src/tools/session-bot.ts`
- Key collaborators:
  - `packages/hackbrowser/` — vendored CyberStrike engine (AGPL, see ATTRIBUTION)
  - `packages/coding-agent/src/pentest/assets.ts` — `runtime/session-bot.mjs` bundle

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `'start' \| 'stop' \| 'status'` | Yes | Lifecycle operation. |
| `sessionDir` | `string` | No | Directory holding the exported session (`session.jar` + `flow.json`). |
| `probe` | `string` | No | URL probed on an interval to detect session expiry. |
| `interval` | `number` | No | Probe interval in seconds (minimum 1). |

## Notes
- Re-authentication replays the login flow from `flow.json`; the session jar is rewritten atomically on every refresh.
- The bot exits fatally after 3 failed re-auths or 5 consecutive network failures — `status` reflects the live state and the process PID.
- Pair with `web_crawl` (`--session-in`) so crawls reuse the guarded session.
