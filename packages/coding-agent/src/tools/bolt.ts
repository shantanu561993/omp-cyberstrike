import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, ToolTier } from "@oh-my-pi/pi-agent-core";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	createBoltTransport,
	deleteBoltCredentials,
	getBoltCredentials,
	listBoltCredentials,
	pairWithBolt,
	BoltNotPairedError,
	type BoltCredentials,
} from "../mcp/bolt";
import { appendLogEntry } from "../pentest/http-log";
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

const boltSchema = type({
	action: "'pair' | 'list' | 'remove' | 'tools' | 'call' | 'run'",
	"name?": "string",
	"url?": "string",
	"adminToken?": "string",
	"tool?": "string",
	"jsonArgs?": "string",
	"command?": "string",
	"out?": "string",
	"phase?": "string",
});

type BoltParams = typeof boltSchema.infer;

export interface BoltToolDetails {
	action: BoltParams["action"];
	name?: string;
}

interface BoltServerEntry {
	url: string;
	timeout?: number;
	enabled?: boolean;
}

function serversFromSettings(session: ToolSession): Record<string, BoltServerEntry> {
	return (session.settings.get("bolt.servers") as Record<string, BoltServerEntry> | undefined) ?? {};
}

function requireServer(servers: Record<string, BoltServerEntry>, name: string): BoltServerEntry {
	const entry = servers[name];
	if (!entry?.url) throw new ToolError(`bolt server '${name}' is not configured (bolt.servers setting)`);
	return entry;
}

export function boltServerStatus(
	servers: Record<string, BoltServerEntry>,
	credsByName: Map<string, BoltCredentials>,
): Array<{ name: string; status: string; url: string }> {
	const out: Array<{ name: string; status: string; url: string }> = [];
	for (const [name, entry] of Object.entries(servers)) {
		const creds = credsByName.get(name);
		if (entry.enabled === false) {
			out.push({ name, status: "disabled", url: entry.url });
		} else if (!creds) {
			out.push({ name, status: "needs_auth", url: entry.url });
		} else if (creds.serverUrl.replace(/\/+$/, "") !== entry.url.replace(/\/+$/, "")) {
			out.push({ name, status: "failed (re-pair required: url changed)", url: entry.url });
		} else {
			out.push({ name, status: "connected", url: entry.url });
		}
	}
	return out;
}

export function renderServerStatus(rows: Array<{ name: string; status: string; url: string }>): string {
	if (rows.length === 0) return "(no bolt.servers configured)";
	return rows.map((r) => `- ${r.name}\t${r.status}\t${r.url}`).join("\n");
}

const boltDescription = `Native CyberStrike Bolt integration. Actions: pair (name url adminToken — runs the Ed25519 pairing flow, saves credentials to the agent dir, then RESTART or /mcp reconnect for the server's MCP tools); list (per-server connected/needs_auth/disabled/failed); remove (name — drop credentials); tools (name — list the server's remote tools); call (name tool jsonArgs — invoke a remote tool with JSON string args); run (name command — shortcut for the server's bash tool). Paired servers also expose MCP tools named mcp__<server>_<tool> once connected (bolt tool: list confirms). URL change invalidates credentials (re-pair demanded). With out (pentest dir) + phase, every call/run is mirrored into http.log (source: "bolt") and its output appended to <out>/remote/<phase>.log.`;

export class BoltTool implements AgentTool<typeof boltSchema, BoltToolDetails> {
	readonly name = "bolt";
	readonly approval: ToolTier = "exec";
	readonly label = "Bolt";
	readonly loadMode = "discoverable";
	readonly summary = "Native Bolt remote-machine integration (pair/list/remove/tools/call/run)";
	readonly description = boltDescription;
	readonly parameters = boltSchema;
	readonly strict = true;

	constructor(readonly session: ToolSession) {}

	async execute(_toolCallId: string, params: BoltParams): Promise<AgentToolResult<BoltToolDetails>> {
		const servers = serversFromSettings(this.session);
		const credsByName = new Map<string, BoltCredentials>();
		for (const name of listBoltCredentials()) {
			const creds = getBoltCredentials(name);
			if (creds) credsByName.set(name, creds);
		}

		switch (params.action) {
			case "pair": {
				if (!params.name || !params.url || !params.adminToken) {
					throw new ToolError("bolt pair requires name, url and adminToken");
				}
				const result = await pairWithBolt(params.name, params.url, params.adminToken);
				return {
					content: [
						{
							type: "text",
							text: `paired: clientId ${result.clientId}, serverFingerprint ${result.serverFingerprint}.\nRESTART the session or run /mcp reconnect for the server's MCP tools (mcp__${params.name}_<tool>).`,
						},
					],
					details: { action: "pair", name: params.name },
				};
			}
			case "list": {
				const rows = boltServerStatus(servers, credsByName);
				return { content: [{ type: "text", text: renderServerStatus(rows) }], details: { action: "list" } };
			}
			case "remove": {
				if (!params.name) throw new ToolError("bolt remove requires name");
				deleteBoltCredentials(params.name);
				return {
					content: [{ type: "text", text: `removed bolt credentials for '${params.name}'` }],
					details: { action: "remove", name: params.name },
				};
			}
			case "tools":
			case "call":
			case "run": {
				if (!params.name) throw new ToolError(`bolt ${params.action} requires name`);
				const entry = requireServer(servers, params.name);
				let transport;
				try {
					transport = createBoltTransport({ url: entry.url, timeout: entry.timeout });
				} catch (err) {
					if (err instanceof BoltNotPairedError) throw new ToolError(err.message);
					throw err;
				}
				try {
					await transport.request("initialize", {
						protocolVersion: "2025-11-25",
						capabilities: { roots: { listChanged: false } },
						clientInfo: { name: "omp", version: "1.0.0" },
					});
					if (params.action === "tools") {
						const list = await transport.request<{ tools: Array<{ name: string; description?: string }> }>(
							"tools/list",
							{},
						);
						const text =
							(list.tools ?? []).length === 0
								? `(server ${params.name} exposes no tools)`
								: list.tools.map((t) => `- ${t.name}\t${t.description ?? ""}`).join("\n");
						return { content: [{ type: "text", text }], details: { action: "tools", name: params.name } };
					}
					let toolName: string;
					let args: Record<string, unknown>;
					if (params.action === "run") {
						if (!params.command) throw new ToolError("bolt run requires command");
						toolName = "bash";
						args = { command: params.command };
					} else {
						if (!params.tool) throw new ToolError("bolt call requires tool");
						toolName = params.tool;
						args = params.jsonArgs ? (JSON.parse(params.jsonArgs) as Record<string, unknown>) : {};
					}
					let result = await transport.request<{
						content?: Array<{ type: string; text?: string }>;
						isError?: boolean;
					}>("tools/call", { name: toolName, arguments: args });
					// Real Bolt servers expose run_command instead of bash: fall back
					// when the server reports the bash tool as unknown.
					if (params.action === "run" && result.isError) {
						const errText = (result.content ?? []).map((c) => c.text ?? "").join("\n");
						if (/unknown tool|tool not found/i.test(errText)) {
							result = await transport.request<{
								content?: Array<{ type: string; text?: string }>;
								isError?: boolean;
							}>("tools/call", { name: "run_command", arguments: { command: params.command } });
							toolName = "run_command";
						}
					}
					const text = (result.content ?? [])
						.map((c) => (c.type === "text" ? (c.text ?? "") : JSON.stringify(c)))
						.join("\n");

					// AUTO-LOG + remote log mirror (when a pentest out dir is given).
					if (params.out) {
						const status = result.isError ? 1 : 0;
						appendLogEntry(params.out, {
							source: "bolt",
							method: toolName.toUpperCase() === "BASH" ? "EXEC" : toolName.toUpperCase(),
							url: `bolt://${params.name}/${toolName}`,
							status,
							phase: params.phase,
							ref: `remote/${params.phase ?? params.name}.log`,
						});
						const remoteDir = path.join(params.out, "remote");
						fs.mkdirSync(remoteDir, { recursive: true });
						fs.appendFileSync(
							path.join(remoteDir, `${params.phase ?? params.name}.log`),
							`[${new Date().toISOString()}] bolt ${params.name} ${toolName} (exit ${status})\n${text}\n`,
						);
					}
					if (result.isError) {
						return {
							content: [{ type: "text", text: `[remote error]\n${text}` }],
							details: { action: "call", name: params.name },
						};
					}
					return { content: [{ type: "text", text }], details: { action: "call", name: params.name } };
				} finally {
					await transport.close().catch(() => {});
				}
			}
			default:
				throw new ToolError(`unknown bolt action: ${String(params.action)}`);
		}
	}
}
