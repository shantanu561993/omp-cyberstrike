import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, ToolTier } from "@oh-my-pi/pi-agent-core";
import { getPentestDir } from "../pentest/assets";
import { appendLogEntry } from "../pentest/http-log";
import { extractTarGz } from "../pentest/tar";
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
	"headed?": "boolean",
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

/**
 * Fallback for checkout-style installs: walk up from the binary path for a
 * workspace node_modules that provides playwright and symlink it into the
 * staged runtime dir.
 */
function linkStagedBundleDeps(bundlePath: string): void {
	const linkTarget = join(dirname(bundlePath), "node_modules");
	if (fs.existsSync(linkTarget)) return;
	let dir = dirname(process.execPath);
	while (true) {
		const nm = join(dir, "node_modules");
		if (fs.existsSync(join(nm, "playwright"))) {
			try {
				fs.symlinkSync(nm, linkTarget, "dir");
			} catch {
				// symlink failed (e.g. permissions) — the spawn below will error clearly
			}
			return;
		}
		const parent = dirname(dir);
		if (parent === dir) return;
		dir = parent;
	}
}

/**
 * In compiled mode the staged runtime dir has no node_modules, so node cannot
 * resolve the bundle's `playwright` import from the bundle location. The
 * generator embeds node_modules/{playwright,playwright-core} as a base64 tar.gz
 * (runtime/node_modules.tar.gz.mjs) — extract it into the staged dir. Falls
 * back to walking up from the binary path for a workspace node_modules
 * (checkout-style installs).
 */
function stageRuntimeDeps(bundleDir: string): void {
	const nm = join(bundleDir, "node_modules");
	if (fs.existsSync(join(nm, "playwright"))) return;
	const b64File = join(bundleDir, "node_modules.tar.gz.mjs");
	if (fs.existsSync(b64File)) {
		try {
			const archive = Buffer.from(fs.readFileSync(b64File, "utf8"), "base64");
			extractTarGz(archive, bundleDir);
			if (fs.existsSync(join(nm, "playwright"))) return;
		} catch {
			// fall through to the workspace walk
		}
	}
	linkStagedBundleDeps(bundleDir);
}

/** Playwright's pinned chromium cache dir for playwright 1.58.2. */
const CHROMIUM_CACHE_DIR = "chromium-1208";

/** Release-asset platform tag (matches release_binary target_id rows). */
function platformTag(): string {
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	if (process.platform === "win32") return `win32-${arch}`;
	if (process.platform === "darwin") return `darwin-${arch}`;
	return `linux-${arch}`;
}

/**
 * Resolve the playwright browsers path. Precedence: PLAYWRIGHT_BROWSERS_PATH
 * env → <exeDir>/browser-deps/ms-playwright (pre-extracted) → auto-extract the
 * sidecar <exeDir>/omp-browser-deps-<tag>.tar.gz (the CI release asset) once →
 * null (compiled mode then errors with instructions; dev falls back to
 * playwright's default cache).
 */
function ensureBrowsers(): string | null {
	if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
	const base = join(dirname(process.execPath), "browser-deps");
	const extracted = join(base, "ms-playwright");
	if (fs.existsSync(join(extracted, CHROMIUM_CACHE_DIR))) return extracted;
	const sidecar = join(dirname(process.execPath), `omp-browser-deps-${platformTag()}.tar.gz`);
	if (fs.existsSync(sidecar)) {
		fs.mkdirSync(base, { recursive: true });
		try {
			extractTarGz(fs.readFileSync(sidecar), base);
		} catch (err) {
			throw new ToolError(`failed to extract browser deps from ${sidecar}: ${(err as Error).message}`);
		}
		if (fs.existsSync(join(extracted, CHROMIUM_CACHE_DIR))) return extracted;
		throw new ToolError(`browser deps extracted from ${sidecar} but ${CHROMIUM_CACHE_DIR} is missing`);
	}
	return null;
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
			const key = await this.session.modelRegistry.getApiKeyForProvider(
				"deepseek",
				this.session.getSessionId?.() ?? undefined,
				{
					forceRefresh: false,
				},
			);
			if (key) keyName = "DEEPSEEK_API_KEY";
		}
		if (!keyName) {
			throw new ToolError("web_crawl needs a DeepSeek/Anthropic/OpenAI key (env or auth store)");
		}

		const bundle = crawlBundlePath();
		if (!fs.existsSync(bundle)) {
			throw new ToolError(`crawl bundle not found: ${bundle} (build it with bun run build in packages/hackbrowser)`);
		}
		if (process.env.PI_COMPILED === "true") {
			stageRuntimeDeps(dirname(bundle));
		}
		const browsersPath = ensureBrowsers();
		if (process.env.PI_COMPILED === "true" && !browsersPath) {
			throw new ToolError(
				`web_crawl needs the playwright browser deps: download omp-browser-deps-${platformTag()}.tar.gz from the release and place it next to the executable (it auto-extracts to browser-deps/), or set PLAYWRIGHT_BROWSERS_PATH to an ms-playwright cache`,
			);
		}

		const args = ["--url", params.url];
		for (const s of (params.scope ?? []) as string[]) args.push("--scope", s);
		args.push("--steps", String(params.steps ?? 10), "--out", outFile);
		if (params.user && params.pass) args.push("--user", params.user, "--pass", params.pass);
		if (params.selU) args.push("--sel-u", params.selU);
		if (params.selP) args.push("--sel-p", params.selP);
		if (params.sessionOut) args.push("--session-out", params.sessionOut);
		if (params.sessionIn) args.push("--session-in", params.sessionIn);
		if (params.headed) args.push("--headed");
		// Headed mode on Linux without a display (containers/CI): wrap in
		// xvfb-run so the visible-browser request still works.
		let command = ["node", bundle, ...args];
		if (params.headed && process.platform === "linux" && !process.env.DISPLAY) {
			if (!fs.existsSync("/usr/bin/xvfb-run")) {
				throw new ToolError(
					"headed crawl on Linux without DISPLAY needs xvfb-run (apt install xvfb) — or run with DISPLAY set",
				);
			}
			command = ["xvfb-run", "-a", ...command];
		}

		const maxTimeout = this.session.settings.get("tools.maxTimeout");
		const timeoutSec = clampTimeout("web_crawl", params.timeout, maxTimeout);
		const proc = Bun.spawn(command, {
			cwd:
				process.env.PI_COMPILED === "true"
					? dirname(bundle)
					: join(import.meta.dir, "..", "..", "..", "hackbrowser"),
			env: {
				...process.env,
				[keyName]: process.env[keyName] as string,
				...(browsersPath ? { PLAYWRIGHT_BROWSERS_PATH: browsersPath } : {}),
				AI_SDK_LOG_WARNINGS: "false",
			},
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
