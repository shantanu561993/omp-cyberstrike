#!/usr/bin/env bun

/**
 * Crawler wrapper around the vendored hackbrowser engine (AGPL-3.0,
 * CyberStrike packages/hackbrowser — see lib/api.ts header).
 *
 * Runs an LLM-navigated crawl of the target and writes every captured
 * request as JSONL (method + URL + status + raw HTTP + response).
 *
 * The vendored engine ingests captures over HTTP to a CyberStrike server;
 * this wrapper starts a minimal local sink on 127.0.0.1:4096 so no external
 * server is needed. `cyberstrikeUrl` is passed explicitly to the engine.
 *
 * Usage:
 *   bun crawl.ts --url <url> [--scope <d>]... [--steps N] [--headless]
 *                [--out <file>] [--user <u>] [--pass <p>]
 *                [--sel-u <css>] [--sel-p <css>]
 *
 * LLM provider (first set wins): DEEPSEEK_API_KEY, ANTHROPIC_API_KEY,
 * OPENAI_API_KEY. Without any key the crawler exits 2.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { type CrawlOptions, runCrawl } from "./src/api.ts";
import { saveSession } from "./src/auth.ts";
import { extractAuthHeaders } from "./src/ingest.ts";
import type { CrawlResult, CSEvent, IngestPayload } from "./src/types.ts";

const USAGE = `Usage: bun crawl.ts --url <url> [options]

Options:
  --url <url>          Target URL (required; scheme + host)
  --scope <domain>     In-scope host; repeatable (default: target's host)
  --steps <N>          Max navigation steps (default: 10)
  --headless           Run headless (always used; flag kept for compat)
  --out <file>         JSONL output file (default: ./requests.jsonl)
  --user <u>           Login username (auto-login on discovered form)
  --pass <p>           Login password
  --sel-u <css>        Username field selector (default: heuristic)
  --sel-p <css>        Password field selector (default: input[type=password])
  --session-out <dir>  Export the authenticated session to <dir> (session.json,
                       cookies.txt Netscape jar, headers.json auth headers)
  --session-in <dir>   Restore a session previously exported with --session-out
  -h, --help           Show this help

Env: DEEPSEEK_API_KEY | ANTHROPIC_API_KEY | OPENAI_API_KEY (one required).
Exit codes: 0 ok, 1 fatal, 2 no LLM key.
`;

interface Args {
	url: string;
	scope: string[];
	steps: number;
	out: string;
	user?: string;
	pass?: string;
	selU?: string;
	selP?: string;
	sessionOut?: string;
	sessionIn?: string;
}

function parseArgs(argv: string[]): Args {
	const args: Args = { url: "", scope: [], steps: 10, out: "./requests.jsonl" };
	const next = (i: number, flag: string): string => {
		const v = argv[i + 1];
		if (!v || v.startsWith("--")) throw new Error(`${flag} requires a value`);
		return v;
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		switch (a) {
			case "-h":
			case "--help":
				console.log(USAGE);
				process.exit(0);
				break; // unreachable — satisfies lint; parseArgs never continues after help
			case "--url":
				args.url = next(i, "--url");
				i++;
				break;
			case "--scope":
				args.scope.push(next(i, "--scope"));
				i++;
				break;
			case "--steps":
				args.steps = Number.parseInt(next(i, "--steps"), 10);
				i++;
				break;
			case "--headless":
				break;
			case "--out":
				args.out = next(i, "--out");
				i++;
				break;
			case "--user":
				args.user = next(i, "--user");
				i++;
				break;
			case "--pass":
				args.pass = next(i, "--pass");
				i++;
				break;
			case "--sel-u":
				args.selU = next(i, "--sel-u");
				i++;
				break;
			case "--sel-p":
				args.selP = next(i, "--sel-p");
				i++;
				break;
			case "--session-out":
				args.sessionOut = next(i, "--session-out");
				i++;
				break;
			case "--session-in":
				args.sessionIn = next(i, "--session-in");
				i++;
				break;
			default:
				throw new Error(`unknown argument: ${a}`);
		}
	}
	if (!args.url) throw new Error("--url is required");
	if (!/^https?:\/\//i.test(args.url)) throw new Error(`--url must include scheme (http/https): ${args.url}`);
	if (args.scope.length === 0) args.scope = [new URL(args.url).hostname];
	return args;
}

// Minimal CyberStrike-ingest sink. The vendored engine POSTs every capture
// here; we answer like the server would and keep the payloads.
interface Sink {
	records: IngestPayload[];
	close: () => Promise<void>;
}

/** Promise.withResolvers polyfill (node 18 lacks it; the container runs node 18). */
function withResolvers<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const SINK_PORT = 4096;
const SINK_HOST = "127.0.0.1";

function startSink(): Promise<Sink> {
	const records: IngestPayload[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			if (req.method === "POST" && req.url?.endsWith("/session/ingest")) {
				try {
					const payload = JSON.parse(body) as IngestPayload;
					records.push(payload);
				} catch {
					/* non-JSON probe — ignore */
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ sessionID: "local-sink" }));
			} else if (req.method === "POST" && req.url?.includes("/web/credentials")) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ id: "cred-local" }));
			} else if (req.method === "PATCH" && req.url?.includes("/web/credentials")) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			} else {
				res.writeHead(404);
				res.end("not found");
			}
		});
	});
	const { promise, resolve, reject } = withResolvers<Sink>();
	server.once("error", reject);
	server.listen(SINK_PORT, SINK_HOST, () => {
		server.removeListener("error", reject);
		resolve({
			records,
			close: () => new Promise(r => server.close(() => r())),
		});
	});
	return promise;
}

function resolveModel() {
	if (process.env.DEEPSEEK_API_KEY) {
		// DeepSeek is OpenAI-compatible; @ai-sdk/deepseek 2.x speaks spec v3,
		// which the pinned ai@5 does not support (AI_UnsupportedModelVersionError).
		return createOpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: "https://api.deepseek.com/v1" })(
			process.env.BROWSER_AGENT_MODEL ?? "deepseek-chat",
		);
	}
	if (process.env.ANTHROPIC_API_KEY) {
		return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(
			process.env.BROWSER_AGENT_MODEL ?? "claude-sonnet-4-6",
		);
	}
	if (process.env.OPENAI_API_KEY) {
		return createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(process.env.BROWSER_AGENT_MODEL ?? "gpt-4o");
	}
	return null;
}

/** First line of a raw HTTP request: `GET /path?q=1 HTTP/1.1`. */
function parseRawRequest(raw: string): { method: string; path: string; host?: string } {
	const lines = raw.split(/\r?\n/);
	const first = lines[0] ?? "";
	const parts = first.split(" ");
	const hostLine = lines.find(l => /^host:/i.test(l));
	return { method: parts[0] ?? "", path: parts[1] ?? "", host: hostLine?.split(":")[1]?.trim() };
}

function normalizeRecord(payload: IngestPayload, scheme: string): Record<string, unknown> {
	const { method, path, host } = parseRawRequest(payload.text ?? "");
	const hostName = host ?? (payload.page_url ? new URL(payload.page_url).host : "");
	const url = `${scheme}://${hostName}${path}`;
	return {
		method,
		url,
		path,
		status: payload.response?.status ?? null,
		host: hostName,
		capturedAt: Date.now(),
		raw: payload.text,
		response: payload.response ?? null,
		pageUrl: payload.page_url ?? null,
		triggerElement: payload.trigger_element ?? null,
	};
}

/** Netscape cookie jar line: domain flag path secure expiry name value */
function toNetscapeJar(
	cookies: Array<{ name: string; value: string; domain: string; path: string; expires: number; secure: boolean }>,
): string {
	const lines = cookies.map(c => {
		const domain = c.domain.startsWith(".") ? c.domain : `.${c.domain}`;
		const expiry = c.expires && c.expires > 0 ? Math.floor(c.expires) : 0;
		return [domain, "TRUE", c.path || "/", c.secure ? "TRUE" : "FALSE", String(expiry), c.name, c.value].join("\t");
	});
	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/** Export the authenticated session: engine session.json + Netscape jar + auth headers. */
async function exportSession(
	context: import("playwright").BrowserContext,
	dir: string,
	records: IngestPayload[],
): Promise<void> {
	mkdirSync(dir, { recursive: true });
	await saveSession(context, join(dir, "session.json"));
	const cookies = await context.cookies();
	writeFileSync(join(dir, "cookies.txt"), toNetscapeJar(cookies));
	// Last observed auth headers across all captured raw requests (Cookie/Authorization/X-Api-Key/...).
	const headers: Record<string, string> = {};
	for (const p of records) {
		Object.assign(headers, extractAuthHeaders(p.text ?? ""));
	}
	writeFileSync(join(dir, "headers.json"), JSON.stringify(headers, null, 2));
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	const model = resolveModel();
	if (!model) {
		console.error("crawler needs DEEPSEEK_API_KEY/ANTHROPIC_API_KEY/OPENAI_API_KEY in env");
		process.exit(2);
	}

	const sink = await startSink();
	const captures: CSEvent[] = [];
	const opts: CrawlOptions = {
		url: args.url,
		scope: args.scope,
		steps: args.steps,
		headless: true,
		panel: false,
		cyberstrikeUrl: `http://${SINK_HOST}:${SINK_PORT}`,
		model,
		eventSink: e => {
			if (e.type === "capture") captures.push(e);
		},
		logSink: record => {
			if (record.level === "ERROR" || record.level === "WARN") {
				console.error(`[crawler:${record.level.toLowerCase()}] ${record.message}`);
			}
		},
	};
	if (args.user && args.pass) {
		opts.credentials = {
			username: args.user,
			password: args.pass,
			usernameSelector: args.selU,
			passwordSelector: args.selP,
		};
	}
	if (args.sessionOut) {
		opts.onCrawlEnd = context => exportSession(context, args.sessionOut!, sink.records);
	}
	if (args.sessionIn) {
		opts.sessionFile = join(args.sessionIn, "session.json");
	}

	let result: CrawlResult;
	try {
		result = await runCrawl(opts);
	} catch (err) {
		console.error(`crawler failed: ${(err as Error).message}`);
		process.exit(1);
	} finally {
		await sink.close();
	}

	const outPath = args.out;
	const dir = join(outPath, "..");
	if (!existsSync(dir)) {
		console.error(`output directory does not exist: ${dir}`);
		process.exit(1);
	}
	const lines = sink.records.map(p => JSON.stringify(normalizeRecord(p, "http")));
	writeFileSync(outPath, lines.join("\n") + (lines.length > 0 ? "\n" : ""));

	console.log(`pages explored: ${result.pagesExplored}`);
	console.log(`captured endpoints: ${result.capturedEndpoints}`);
	console.log(`output: ${outPath} (${lines.length} records)`);
	if (args.sessionOut) {
		console.log(
			`session exported: ${args.sessionOut}/session.json, ${args.sessionOut}/cookies.txt, ${args.sessionOut}/headers.json`,
		);
	}
	for (const e of result.errors) console.error(`error: ${e}`);
	process.exit(result.errors.length > 0 ? 1 : 0);
}

main().catch(err => {
	console.error(`crawler failed: ${(err as Error).message}`);
	process.exit(1);
});
