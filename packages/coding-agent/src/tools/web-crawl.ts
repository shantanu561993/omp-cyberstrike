import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, ToolTier } from "@oh-my-pi/pi-agent-core";
import * as fs from "node:fs";
import { join } from "node:path";
import { appendLogEntry } from "../pentest/http-log";
import { getPentestDir } from "../pentest/assets";
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";
import { clampTimeout } from "./tool-timeouts";

const webCrawlSchema = type({
	url: "string",
	"scope?": "string[]",
	"steps?": "number.integer >= 1",
	"out?": "string",
	"user?": "string",
	"pass?": "string",
	"selU?": "string",
	"selP?": "string",
	"sessionOut?": "string",
	"sessionIn?": "string",
	"timeout?": "number.integer >= 1",
});

type WebCrawlParams = typeof webCrawlSchema.infer;

export interface WebCrawlToolDetails {
	url: string;
	out: string;
	records: number;
	sessionOut?: string;
}

/** Resolve the crawl bundle: dev = the real package dir, compiled = staged assets. */
function crawlBundlePath(): string {
	if (process.env.PI_COMPILED === "true") {
		return join(getPentestDir(), "runtime", "crawl.mjs");
	}
	return join(import.meta.dir, "..", "..", "..", "hackbrowser", "dist", "crawl.mjs");
}

const webCrawlDescription = `LLM-navigated crawl of a web application (vendored CyberStrike hackbrowser). Visits the target, discovers links/forms, captures EVERY request/response to <out>/requests.jsonl (JSONL: method, url, path, status, raw request, response, pageUrl), and auto-logs each capture into <out>/http.log (source: "crawl"). Options: scope (in-scope hosts; defaults to the target host), steps (navigation budget, default 10), user/pass + selU/selP (auto-login on the discovered form), sessionOut (export the authenticated session to a per-role dir: session.json + cookies.txt Netscape jar + headers.json — usable by curl -b/-c and scanners --token-a), sessionIn (restore a previously exported session for a continuation crawl). Requires a DeepSeek/Anthropic/OpenAI key (env or the session auth store).`;

export class WebCrawlTool implements AgentTool<typeof webCrawlSchema, WebCrawlToolDetails> {
	readonly name = "web_crawl";
	readonly approval: ToolTier = "exec";
	readonly label = "Web Crawl";
	readonly loadMode = "discoverable";
	readonly summary = "LLM-navigated crawl with full HTTP capture + session export";
	readonly description = webCrawlDescription;
	readonly parameters = webCrawlSchema;
	readonly strict = true;

	constructor(readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: WebCrawlParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<WebCrawlToolDetails>> {
		const out = params.out ?? this.session.cwd;
		fs.mkdirSync(out, { recursive: true });
		const outFile = join(out, "requests.jsonl");

		// LLM key: env first, then the session auth store (deepseek provider).
		let keyName: string | undefined;
		for (const name of ["DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
			if (process.env[name]) {
				keyName = name;
				break;
			}
		}
		if (!keyName && this.session.modelRegistry) {
			const key = await this.session.modelRegistry.getApiKeyForProvider("deepseek", this.session.getSessionId?.(), {
				forceRefresh: false,
			});
			if (key) keyName = "DEEPSEEK_API_KEY";
		}
		if (!keyName) {
			throw new ToolError("web_crawl needs a DeepSeek/Anthropic/OpenAI key (env or auth store)");
		}

		const bundle = crawlBundlePath();
		if (!fs.existsSync(bundle)) {
			throw new ToolError(`crawl bundle not found: ${bundle} (build it with bun run build in packages/hackbrowser)`);
		}

		const args = ["--url", params.url];
		for (const s of params.scope ?? []) args.push("--scope", s);
		args.push("--steps", String(params.steps ?? 10), "--out", outFile);
		if (params.user && params.pass) args.push("--user", params.user, "--pass", params.pass);
		if (params.selU) args.push("--sel-u", params.selU);
		if (params.selP) args.push("--sel-p", params.selP);
		if (params.sessionOut) args.push("--session-out", params.sessionOut);
		if (params.sessionIn) args.push("--session-in", params.sessionIn);

		const maxTimeout = this.session.settings.get("tools.maxTimeout");
		const timeoutSec = clampTimeout("web_crawl", params.timeout, maxTimeout);
		const proc = Bun.spawn(["node", bundle, ...args], {
			cwd: join(import.meta.dir, "..", "..", "..", "hackbrowser"),
			env: { ...process.env, [keyName]: process.env[keyName] as string, AI_SDK_LOG_WARNINGS: "false" },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(timeoutSec * 1000)])
				: AbortSignal.timeout(timeoutSec * 1000),
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			Bun.readableStreamToText(proc.stdout),
			Bun.readableStreamToText(proc.stderr),
		]);

		if (exitCode === 2) {
			throw new ToolError(stderr.trim() || stdout.trim() || "crawler exited 2 (no LLM key)");
		}

		// AUTO-LOG: index every capture into http.log (bodies stay in requests.jsonl).
		let records = 0;
		if (fs.existsSync(outFile)) {
			const lines = fs.readFileSync(outFile, "utf8").trimEnd().split("\n").filter(Boolean);
			records = lines.length;
			for (let i = 0; i < lines.length; i++) {
				try {
					const rec = JSON.parse(lines[i]) as { method: string; url: string; status?: number | null };
					appendLogEntry(out, {
						source: "crawl",
						method: rec.method || "GET",
						url: rec.url ?? params.url,
						status: rec.status ?? 0,
						ref: `requests.jsonl#${i + 1}`,
					});
				} catch {
					// skip malformed lines
				}
			}
		}
		if (params.sessionOut) {
			for (const name of ["session.json", "cookies.txt", "headers.json"]) {
				if (fs.existsSync(join(params.sessionOut, name))) {
					appendLogEntry(out, {
						source: "session",
						method: "EXPORT",
						url: params.url,
						status: 0,
						ref: `session/${name}`,
					});
				}
			}
		}

		const text = [stdout.trim(), stderr.trim() ? `[stderr]\n${stderr.trim().slice(-2000)}` : ""]
			.filter(Boolean)
			.join("\n\n");
		if (exitCode !== 0) {
			text.concat(`\n[exit code ${exitCode}]`);
		}
		return {
			content: [{ type: "text", text }],
			details: { url: params.url, out, records, sessionOut: params.sessionOut },
		};
	}
}
