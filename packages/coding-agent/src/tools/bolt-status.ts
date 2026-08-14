import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, ToolTier } from "@oh-my-pi/pi-agent-core";
import { getBoltCredentials, listBoltCredentials, type BoltCredentials } from "../mcp/bolt";
import { boltServerStatus, renderServerStatus } from "./bolt";
import type { ToolSession } from "./index";

const boltStatusSchema = type({});

type BoltStatusParams = typeof boltStatusSchema.infer;

export interface BoltStatusToolDetails {
	servers: Array<{ name: string; status: string; url: string }>;
}

const boltStatusDescription = `Read-only status of configured Bolt servers (bolt.servers): one line per server with connected / needs_auth / disabled / failed (re-pair required). Always check this before relying on a Bolt server's MCP tools (mcp__<server>_<tool>).`;

export class BoltStatusTool implements AgentTool<typeof boltStatusSchema, BoltStatusToolDetails> {
	readonly name = "bolt_status";
	readonly approval: ToolTier = "read";
	readonly label = "Bolt Status";
	readonly loadMode = "discoverable";
	readonly summary = "Per-server Bolt connection status (read-only)";
	readonly description = boltStatusDescription;
	readonly parameters = boltStatusSchema;
	readonly strict = true;

	constructor(readonly session: ToolSession) {}

	async execute(_toolCallId: string, _params: BoltStatusParams): Promise<AgentToolResult<BoltStatusToolDetails>> {
		const servers = (this.session.settings.get("bolt.servers") as
			| Record<string, { url: string; timeout?: number; enabled?: boolean }>
			| undefined) ?? {};
		const credsByName = new Map<string, BoltCredentials>();
		for (const name of listBoltCredentials()) {
			const creds = getBoltCredentials(name);
			if (creds) credsByName.set(name, creds);
		}
		const rows = boltServerStatus(servers, credsByName);
		return {
			content: [{ type: "text", text: renderServerStatus(rows) }],
			details: { servers: rows },
		};
	}
}
