# web_crawl

> LLM-navigated crawl of a target site with full HTTP capture and session export.

## Source
- Entry: `packages/coding-agent/src/tools/web-crawl.ts`
- Key collaborators:
  - `packages/hackbrowser/` — vendored CyberStrike headless-browser engine (AGPL, see ATTRIBUTION)
  - `packages/coding-agent/src/pentest/assets.ts` — runtime bundle resolution (`runtime/crawl.mjs`, `runtime/session-bot.mjs`)

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | `string` | Yes | Entry URL to crawl. |
| `scope` | `string[]` | No | URL-prefix allow-list; navigation outside scope is refused. |
| `steps` | `number` | No | Maximum navigation steps (default bounded; minimum 1). |
| `out` | `string` | No | Output directory for the crawl log, request/response captures, and session export. |

## Notes
- Every HTTP interaction is captured into the crawl log (<out>/http.log).
- With a prior `session_bot`/`--session-in` export, the crawl authenticates with the saved cookies and headers (Netscape jar + headers.json).
- **Browser provisioning (compiled binary)**: playwright + playwright-core are embedded; the browser builds ship as `omp-browser-deps-<platform>.tar.gz` release assets. Place the file next to the executable — `web_crawl` auto-extracts it to `browser-deps/` on first use (built-in extractor, no external tools) — or set `PLAYWRIGHT_BROWSERS_PATH` to an `ms-playwright` cache. Without either, the tool errors with the exact asset name to download.
- Crawl runs in the bundled Chromium; results stream back as the navigation progresses.
