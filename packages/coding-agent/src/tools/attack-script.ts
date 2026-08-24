import { existsSync } from "node:fs";
import { join } from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, ToolTier } from "@oh-my-pi/pi-agent-core";
import { enumeratePythonRuntimes } from "../eval/py/runtime";
import { getPentestDir } from "../pentest/assets";
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";
import { clampTimeout } from "./tool-timeouts";

/**
 * The 16 CyberStrike attack scanners, vendored as staged assets under
 * src/pentest/scanners (see scripts/port-cyberstrike-skills.ts).
 */
export const ATTACK_SCANNERS = [
	"cloud_storage_enum",
	"cors_checker",
	"file_upload_tester",
	"github_dorker",
	"graphql_tester",
	"idor_tester",
	"jwt_tamper",
	"oauth_tester",
	"race_tester",
	"rate_limit_bypass",
	"response_diff",
	"ssrf_listener",
	"ssti_tester",
	"subdomain_takeover",
	"waf_bypass",
	"wayback_endpoints",
] as const;

export type AttackScanner = (typeof ATTACK_SCANNERS)[number];

const attackScriptSchema = type({
	script: ATTACK_SCANNERS.map(name => `'${name}'`).join(" | "),
	"args?": "string[]",
	"timeout?": "number.integer >= 1",
});

type AttackScriptParams = typeof attackScriptSchema.infer;

export interface AttackScriptToolDetails {
	script: AttackScanner;
	exitCode: number;
	command: string;
}

export const attackScriptDescription = `Run one of the 16 embedded CyberStrike web pentest scanners against a target. Scanners: ${ATTACK_SCANNERS.join(", ")}. Pass \`args\` as the scanner's CLI arguments (run the script with args ["--help"] first when unsure of the syntax). Long-running scanners (e.g. ssrf_listener) may be started with a high \`timeout\`; their output is streamed to the result. Output of every sweep run should be saved to <out>/sweep/<scanner>.log.`;

export class AttackScriptTool implements AgentTool<typeof attackScriptSchema, AttackScriptToolDetails> {
	readonly name = "attack_script";
	readonly approval: ToolTier = "exec";
	readonly label = "Attack Script";
	readonly loadMode = "discoverable";
	readonly summary = "Run a CyberStrike web pentest scanner (16 built-in scripts)";
	readonly description = attackScriptDescription;
	readonly parameters = attackScriptSchema;
	readonly strict = true;

	constructor(readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: AttackScriptParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<AttackScriptToolDetails>> {
		const scriptPath = join(getPentestDir(), "scanners", `${params.script}.py`);
		if (!existsSync(scriptPath)) {
			throw new ToolError(`scanner script not found: ${params.script} (expected ${scriptPath})`);
		}

		const [runtime] = enumeratePythonRuntimes(this.session.cwd, {});
		const python = runtime?.pythonPath ?? "python3";

		const maxTimeout = this.session.settings.get("tools.maxTimeout");
		const timeoutSec = clampTimeout("attack_script", params.timeout, maxTimeout);

		const args = [python, scriptPath, ...(params.args ?? [])];
		const proc = Bun.spawn(args, {
			cwd: this.session.cwd,
			env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
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

		const sections: string[] = [];
		const trimmedOut = stdout.trim();
		const trimmedErr = stderr.trim();
		if (trimmedOut) sections.push(`[stdout]\n${trimmedOut}`);
		if (trimmedErr) sections.push(`[stderr]\n${trimmedErr.slice(-4000)}`);
		sections.push(`[exit code ${exitCode}]`);

		return {
			content: [{ type: "text", text: sections.join("\n\n") }],
			details: { script: params.script as AttackScanner, exitCode, command: args.join(" ") },
		};
	}
}
