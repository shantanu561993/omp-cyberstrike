/**
 * `omp bolt` — native Bolt server management (pair/list/remove/status).
 *
 * Mirrors the `bolt` tool actions as a plain CLI command, so adding a Bolt
 * server never requires the LLM: configure the server (mcp.json
 * `{"type": "bolt"}` or `bolt.servers`), pair it here, and the session's
 * MCP manager reconnects on its own once the credentials exist.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runBoltCommand } from "../cli/bolt-cli";

export default class Bolt extends Command {
	static description = "Manage CyberStrike Bolt servers (pair/list/remove/status)";

	static args = {
		action: Args.string({
			description: "Action: pair | list | remove | status (default list)",
			options: ["pair", "list", "remove", "status"],
			required: false,
		}),
		name: Args.string({ description: "Server name", required: false }),
		url: Args.string({ description: "Bolt server URL (pair)", required: false }),
	};

	static flags = {
		name: Flags.string({ description: "Server name" }),
		url: Flags.string({ description: "Bolt server URL (pair)" }),
		"admin-token": Flags.string({ description: "Admin token used during pairing to mint the client identity" }),
	};

	static examples = [
		"omp config set bolt.servers.mybolt.url https://bolt.example.com   # native config, same as any MCP server",
		"omp bolt pair mybolt https://bolt.example.com --admin-token t0ken   # key exchange, then auto-reconnect",
		"omp bolt list",
		"omp bolt status",
		"omp bolt remove mybolt",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Bolt);
		await runBoltCommand({
			action: (args.action as "pair" | "list" | "remove" | "status" | undefined) ?? "list",
			name: args.name,
			url: args.url,
			adminToken: flags["admin-token"],
		});
	}
}
