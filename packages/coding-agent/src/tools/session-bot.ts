import * as fs from "node:fs";
import { join } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, ToolTier } from "@oh-my-pi/pi-agent-core";
import { getPentestDir } from "../pentest/assets";
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

const sessionBotSchema = type({
	action: "'start' | 'stop' | 'status'",
	"sessionDir?": "string",
	"probe?": "string",
	"interval?": "number.integer >= 1",
	"drift?": "number",
});

type SessionBotParams = typeof sessionBotSchema.infer;

export interface SessionBotToolDetails {
	action: "start" | "stop" | "status";
	sessionDir?: string;
	pid?: number;
}

/** Resolve the bot bundle: dev = the real package dir, compiled = staged assets. */
function botBundlePath(): string {
	if (process.env.PI_COMPILED === "true") {
		return join(getPentestDir(), "runtime", "session-bot.mjs");
	}
	return join(import.meta.dir, "..", "..", "..", "hackbrowser", "dist", "session-bot.mjs");
}

function pidPath(sessionDir: string): string {
	return join(sessionDir, "bot.pid");
}

const sessionBotDescription = `Session-guardian bot for the web pentest: keeps an exported per-role session alive in the background. start: validates <sessionDir>/cookies.txt (+ flow.json + credentials.json — written by the /pentest session flow), spawns the bot DETACHED, writes <sessionDir>/bot.pid. The bot probes <probe> (an authenticated endpoint; default: first authenticated capture) every <interval> seconds (default 15; scale by the rate_limit_policy: gentle 30s, aggressive 5s); a session is DEAD on non-2xx, redirect-to-login, or content-length drift > <drift> (default 0.25); it re-authenticates by replaying <sessionDir>/flow.json and atomically refreshes cookies.txt/headers.json. Every tick appends one JSONL line to <sessionDir>/bot.log. Fatal stop after 3 reauth failures or 5 consecutive network errors. stop: kills the bot (pid file removed). status: running/stopped/fatal + last 3 ticks. The /pentest command starts one bot per account after discover-login and stops all bots at finalization.`;

export class SessionBotTool implements AgentTool<typeof sessionBotSchema, SessionBotToolDetails> {
	readonly name = "session_bot";
	readonly approval: ToolTier = "exec";
	readonly label = "Session Bot";
	readonly loadMode = "discoverable";
	readonly summary = "Background session-guardian bot (start/stop/status) per exported role session";
	readonly description = sessionBotDescription;
	readonly parameters = sessionBotSchema;
	readonly strict = true;

	constructor(readonly session: ToolSession) {}

	async execute(_toolCallId: string, params: SessionBotParams): Promise<AgentToolResult<SessionBotToolDetails>> {
		if (!params.sessionDir) throw new ToolError("session_bot requires `sessionDir`");
		const pidFile = pidPath(params.sessionDir);

		switch (params.action) {
			case "start": {
				for (const name of ["cookies.txt", "flow.json", "credentials.json"]) {
					if (!fs.existsSync(join(params.sessionDir, name))) {
						throw new ToolError(
							`session_bot start: missing ${params.sessionDir}/${name} (run the /pentest session export first)`,
						);
					}
				}
				if (!params.probe) throw new ToolError("session_bot start requires `probe`");
				if (fs.existsSync(pidFile)) {
					const existing = Number(fs.readFileSync(pidFile, "utf8").trim());
					if (existing > 0 && process.kill(existing, 0)) {
						throw new ToolError(`session_bot already running for ${params.sessionDir} (pid ${existing})`);
					}
					fs.rmSync(pidFile, { force: true });
				}

				const bundle = botBundlePath();
				if (!fs.existsSync(bundle)) {
					throw new ToolError(`session-bot bundle not found: ${bundle}`);
				}
				const args = [
					"--session",
					params.sessionDir,
					"--probe",
					params.probe,
					"--interval",
					String(params.interval ?? 15),
					"--drift",
					String(params.drift ?? 0.25),
				];
				const proc = Bun.spawn(["node", bundle, ...args], {
					cwd: join(import.meta.dir, "..", "..", "..", "hackbrowser"),
					env: { ...process.env },
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
					detached: true,
				});
				proc.unref();
				fs.writeFileSync(pidFile, String(proc.pid));
				return {
					content: [
						{
							type: "text",
							text: `session_bot started for ${params.sessionDir} (pid ${proc.pid}, probe ${params.probe}, interval ${params.interval ?? 15}s, drift ${params.drift ?? 0.25})`,
						},
					],
					details: { action: "start", sessionDir: params.sessionDir, pid: proc.pid },
				};
			}
			case "stop": {
				if (!fs.existsSync(pidFile)) {
					throw new ToolError(`session_bot not running for ${params.sessionDir} (no pid file)`);
				}
				const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
				try {
					process.kill(pid, "SIGTERM");
				} catch {
					// already gone
				}
				// Give it a moment, then force.
				await new Promise(r => setTimeout(r, 500));
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// already gone
				}
				fs.rmSync(pidFile, { force: true });
				return {
					content: [{ type: "text", text: `session_bot stopped for ${params.sessionDir} (pid ${pid})` }],
					details: { action: "stop", sessionDir: params.sessionDir, pid },
				};
			}
			case "status": {
				let pid: number | undefined;
				if (fs.existsSync(pidFile)) {
					pid = Number(fs.readFileSync(pidFile, "utf8").trim());
					const alive = pid > 0 && process.kill(pid, 0);
					if (!alive) {
						pid = undefined;
						fs.rmSync(pidFile, { force: true });
					}
				}
				const logPath = join(params.sessionDir, "bot.log");
				let tail = "";
				if (fs.existsSync(logPath)) {
					const lines = fs.readFileSync(logPath, "utf8").trimEnd().split("\n").filter(Boolean);
					tail = lines.slice(-3).join("\n");
				}
				const state = pid !== undefined ? "running" : tail.includes('"action":"fatal"') ? "fatal" : "stopped";
				const text = [`session_bot for ${params.sessionDir}: ${state}${pid !== undefined ? ` (pid ${pid})` : ""}`];
				if (tail) text.push(tail);
				return {
					content: [{ type: "text", text: text.join("\n") }],
					details: { action: "status", sessionDir: params.sessionDir, pid },
				};
			}
			default:
				throw new ToolError(`unknown session_bot action: ${String(params.action)}`);
		}
	}
}
