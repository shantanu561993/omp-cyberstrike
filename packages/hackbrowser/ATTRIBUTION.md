# Attribution — vendored CyberStrike hackbrowser (AGPL-3.0)

This package (`packages/hackbrowser/`) vendors **CyberStrike**
`packages/hackbrowser` source (AGPL-3.0-only), checkout commit
`71e14833cc2b003ed02837318e22bc769ddd8e21`:

- Upstream: https://github.com/CyberStrikeus/CyberStrike
- Fork used: https://github.com/shantanu561993/CyberStrike (also attributed upstream)

## Mechanical fixes applied to the vendored source

1. **`crawl.ts` (OMP-authored wrapper, MIT)** — CLI entry that starts a local
   ingest sink on `127.0.0.1:4096` (no CyberStrike server), resolves the LLM
   provider from env (`DEEPSEEK_API_KEY` via an OpenAI-compatible endpoint,
   because `@ai-sdk/deepseek` 2.x speaks spec v3 while the pinned `ai@5` does
   not), and writes captured requests as JSONL. Runs as a **node bundle**
   (`dist/crawl.mjs`) because bun's in-process Playwright launch hangs on some
   Windows hosts; node does not (verified).
2. **Session export** (`--session-out <dir>` / `--session-in <dir>`): the
   engine already had `saveSession`/`loadSession`/`extractAuthHeaders`; the
   vendored `src/api.ts` gained an `onCrawlEnd` option (threaded through
   `AgentConfig.auth`) so the wrapper can capture the live `BrowserContext`
   right before teardown and export `session.json` (engine format),
   `cookies.txt` (Netscape jar) and `headers.json` (last-observed auth headers).
3. **`session-bot.ts` (OMP-authored, MIT)** — session-guardian background
   process: probes an authenticated endpoint every N seconds, detects
   session death (non-2xx or content-length drift), re-authenticates via the
   recorded login flow, and atomically refreshes the cookie jar.

## Redistribution

Ported/vendored content MUST NOT be upstreamed into `can1357/oh-my-pi`
without relicensing. OMP-authored additions (crawl.ts wrapper, session
export, session-bot) are MIT like Oh My Pi.
