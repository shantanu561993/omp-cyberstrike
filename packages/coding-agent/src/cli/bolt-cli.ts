/**
 * `omp bolt` implementation — native Bolt server management.
 *
 * Standalone CLI command; no session/LLM involved. Pairing runs the Ed25519
 * key exchange and stores credentials in the agent dir
 * (`~/.omp-cyberstrike/agent/bolt-keys/<name>.json`); the MCP manager
 * connects configured servers at startup, so after `pair` the server's
 * `mcp__<name>_<tool>` tools appear on the next session (or `/mcp
 * reconnect <name>` in a running one).
 */
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import type { BoltCredentials } from "../mcp/bolt";
import { deleteBoltCredentials, getBoltCredentials, listBoltCredentials, pairWithBolt } from "../mcp/bolt";
import { loadAllMCPConfigs } from "../mcp/config";
import { boltServerStatus, renderServerStatus } from "../tools/bolt";

export interface BoltCommandArgs {
	action: "pair" | "list" | "remove" | "status";
	name?: string;
	url?: string;
	adminToken?: string;
}

/** Read bolt.servers from the current settings (empty when unavailable). */
function boltServers(settings: Settings): Record<string, { url: string; timeout?: number; enabled?: boolean }> {
	return (
		(settings.get("bolt.servers") as
			| Record<string, { url: string; timeout?: number; enabled?: boolean }>
			| undefined) ?? {}
	);
}

export async function runBoltCommand(args: BoltCommandArgs): Promise<void> {
	switch (args.action) {
		case "pair": {
			if (!args.name || !args.adminToken) {
				console.error(
					"Usage: omp bolt pair <name> [<url>] --admin-token <token> (url optional when the server is already configured)",
				);
				process.exit(1);
			}
			// A bolt server is declared like any other MCP server (mcp.json
			// {"type": "bolt"} or bolt.servers); pairing attaches the Ed25519
			// credentials. When no url is given, resolve it from the declared
			// config so pairing is a one-command credential step.
			let url = args.url;
			if (!url) {
				const { configs } = await loadAllMCPConfigs(getProjectDir());
				const found = configs[args.name];
				if (found && found.type === "bolt" && found.url) {
					url = found.url;
				} else {
					console.error(
						`No configured bolt server named '${args.name}'. Declare it first (like any MCP server): ` +
							`omp config set bolt.servers.${args.name}.url <url> or an mcp.json {"type": "bolt"} entry, then pair again.`,
					);
					process.exit(1);
				}
			}
			const { clientId, serverFingerprint } = await pairWithBolt(args.name, url, args.adminToken);
			// Pairing alone leaves the MCP manager with nothing to connect (the
			// confusing "No MCP servers configured" state). Auto-declare the
			// server in bolt.servers so the session registers it at startup.
			const settings = await Settings.init();
			const servers =
				(settings.get("bolt.servers") as
					| Record<string, { url: string; timeout?: number; enabled?: boolean }>
					| undefined) ?? {};
			const existing = servers[args.name];
			if (!existing) {
				settings.set("bolt.servers", { ...servers, [args.name]: { url } });
				await settings.flush();
				console.log(`declared '${args.name}' in bolt.servers (url ${url})`);
			} else if (existing.url.replace(/\/+$/, "") !== url.replace(/\/+$/, "")) {
				console.warn(
					`warning: bolt.servers.${args.name}.url is '${existing.url}' but you paired against '${url}' — the session connects to the declared URL.`,
				);
			}
			console.log(`paired: clientId ${clientId}, serverFingerprint ${serverFingerprint}`);
			console.log(
				`Credentials stored for '${args.name}'. The MCP manager connects configured Bolt servers at startup — ` +
					`start a session (or run /mcp reconnect ${args.name}) to get the mcp__${args.name}_<tool> tools.`,
			);
			return;
		}
		case "list":
		case "status": {
			const settings = await Settings.loadReadOnly({ cwd: getProjectDir() });
			const credsByName = new Map<string, BoltCredentials>();
			for (const name of listBoltCredentials()) {
				const creds = getBoltCredentials(name);
				if (creds) credsByName.set(name, creds);
			}
			// Every declared bolt server, native-style: mcp.json (or the
			// legacy bolt.servers setting) entries both count.
			const servers = boltServers(settings);
			const { configs } = await loadAllMCPConfigs(getProjectDir());
			for (const [name, cfg] of Object.entries(configs)) {
				if (cfg.type === "bolt" && !(name in servers)) {
					servers[name] = { url: cfg.url };
				}
			}
			console.log(renderServerStatus(boltServerStatus(servers, credsByName)));
			return;
		}
		case "remove": {
			if (!args.name) {
				console.error("Usage: omp bolt remove <name>");
				process.exit(1);
			}
			deleteBoltCredentials(args.name);
			console.log(`removed bolt credentials for '${args.name}'`);
			return;
		}
	}
}
