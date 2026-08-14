# Web Pentest Crawler

LLM-navigated crawl of a target web application with raw HTTP capture,
output as JSONL. Wrapper around the vendored CyberStrike hackbrowser engine.

## Usage

Run the prebuilt bundle (recommended):

```bash
node dist/crawl.mjs --url https://target.example --scope target.example --steps 10 --out ./requests.jsonl
```

Or rebuild the bundle from source and run:

```bash
bun build crawl.ts --target node --format esm \
  --external electron --external playwright --external playwright-core \
  --external "ai" --external "@ai-sdk/*" --external psl \
  --outfile dist/crawl.mjs
node dist/crawl.mjs --url ... 
```

Options: `--url` (required), `--scope` (repeatable), `--steps N`,
`--headless`, `--out <file>` (default `./requests.jsonl`), `--user`/`--pass`
(auto-login), `--sel-u <css>`/`--sel-p <css>` (login field selectors).

Why node? `bun crawl.ts` works except for one machine-dependent issue:
bun's Playwright browser launch hangs on some Windows setups (the browser
spawns but the CDP pipe handshake never completes; node completes the same
launch in ~150 ms). The bundle is built with `bun build` from the same
`crawl.ts` — no behavioral difference.

## Environment

One LLM API key is required (first wins):

- `DEEPSEEK_API_KEY` — used via the OpenAI-compatible endpoint
  (`https://api.deepseek.com/v1`, model `deepseek-chat`); `@ai-sdk/deepseek`
  2.x is NOT used because it speaks spec v3, unsupported by the pinned `ai@5`.
- `ANTHROPIC_API_KEY` (default model `claude-sonnet-4-6`)
- `OPENAI_API_KEY` (default model `gpt-4o`)

`BROWSER_AGENT_MODEL` overrides the default model name. Without any key the
crawler exits 2 with a message.

## Browser

Playwright Chromium must be installed once (version must match the pinned
`playwright` dep — run inside this directory):

```bash
bunx playwright install chromium
```

(Downloads to `%USERPROFILE%\AppData\Local\ms-playwright` on Windows.)

## How it works

The vendored engine (CyberStrike `packages/hackbrowser`, AGPL-3.0) crawls the
target with a Playwright Chromium instance, planning navigation steps with the
LLM, and captures every request (raw HTTP + response + UI context). The engine
ingests captures over HTTP to a CyberStrike server; this wrapper starts a
minimal local sink on `127.0.0.1:4096` (responding to `/session/ingest` etc.)
so no external server is needed. Every captured request is written as one
JSONL line: `method`, `url`, `path`, `status`, `raw`, `response`, `pageUrl`,
`triggerElement`.

## Vendored lib provenance

`lib/` is a verbatim copy of CyberStrike `packages/hackbrowser/src` (AGPL-3.0,
commit `71e14833cc2b003ed02837318e22bc769ddd8e21`), plus mechanical fixes
required to run in this environment; the complete list is in
`../../ATTRIBUTION.md`. No protocol or behavioral changes were made.
