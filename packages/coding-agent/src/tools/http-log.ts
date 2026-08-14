import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, ToolTier } from "@oh-my-pi/pi-agent-core";
import {
	appendLogEntry,
	HTTP_LOG_MAX_QUERY_LINES,
	HTTP_LOG_READ_DEFAULT_CHARS,
	HTTP_LOG_READ_MAX_CHARS,
	HTTP_LOG_SOURCES,
	queryLogEntries,
	readLogBody,
	renderLogEntries,
} from "../pentest/http-log";
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

const httpLogSchema = type({
	action: "'append' | 'query' | 'read'",
	"out?": "string",
	"phase?": "string",
	"source?": HTTP_LOG_SOURCES.map(s => `'${s}'`).join(" | "),
	"method?": "string",
	"url?": "string",
	"status?": "number.integer >= 100 | string",
	"body?": "string",
	"seq?": "number.integer >= 1",
	"maxChars?": "number.integer >= 1",
});

type HttpLogParams = typeof httpLogSchema.infer;

export interface HttpLogToolDetails {
	action: "append" | "query" | "read";
	seq?: number;
	count?: number;
}

const httpLogDescription = `All-traffic audit log of the web pentest: every HTTP interaction is indexed in <out>/http.log (JSONL: seq, ts, phase, source, method, url, status, bytes, sha, ref); full bodies live in <out>/responses/<sha8>.txt (deduped by content hash, 1 MB cap). Token contract: nothing is auto-injected; query/read are the only way results enter context, and both are hard-capped by the tool. append: index one interaction (requires source, method, url, status; optional body/phase/ref — ref when the body lives elsewhere, e.g. requests.jsonl#N, sweep/<scanner>.log, remote/<phase>.log). query: filter by phase/source/method/url-substring/status; returns the NEWEST up to ${HTTP_LOG_MAX_QUERY_LINES} matching lines. read: seq -> the stored body, truncated to maxChars (default ${HTTP_LOG_READ_DEFAULT_CHARS}, hard max ${HTTP_LOG_READ_MAX_CHARS}). Files survive compaction — use query/read after compaction to recall evidence.`;

export class HttpLogTool implements AgentTool<typeof httpLogSchema, HttpLogToolDetails> {
	readonly name = "http_log";
	readonly approval: ToolTier = "write";
	readonly label = "HTTP Log";
	readonly loadMode = "discoverable";
	readonly summary = "Indexed all-traffic audit log for the web pentest (append/query/read)";
	readonly description = httpLogDescription;
	readonly parameters = httpLogSchema;
	readonly strict = true;

	constructor(readonly session: ToolSession) {}

	async execute(_toolCallId: string, params: HttpLogParams): Promise<AgentToolResult<HttpLogToolDetails>> {
		if (!params.out) throw new ToolError("http_log requires `out` (the pentest working directory)");

		switch (params.action) {
			case "append": {
				if (!params.source) throw new ToolError("append requires `source`");
				if (!params.method) throw new ToolError("append requires `method`");
				if (!params.url) throw new ToolError("append requires `url`");
				if (params.status === undefined) throw new ToolError("append requires `status`");
				const seq = appendLogEntry(params.out, {
					source: params.source as string,
					method: params.method as string,
					url: params.url as string,
					status: params.status as number | string,
					phase: params.phase as string | undefined,
					body: params.body as string | undefined,
				});
				return {
					content: [{ type: "text", text: `logged seq ${seq} to ${params.out}/http.log` }],
					details: { action: "append", seq },
				};
			}
			case "query": {
				const entries = queryLogEntries(params.out, {
					phase: params.phase as string | undefined,
					source: params.source as string | undefined,
					method: params.method as string | undefined,
					url: params.url as string | undefined,
					status: params.status as number | string | undefined,
				});
				return {
					content: [{ type: "text", text: renderLogEntries(entries) }],
					details: { action: "query", count: entries.length },
				};
			}
			case "read": {
				if (params.seq === undefined) throw new ToolError("read requires `seq`");
				const body = readLogBody(params.out, params.seq, params.maxChars);
				return {
					content: [{ type: "text", text: body }],
					details: { action: "read", seq: params.seq },
				};
			}
			default:
				throw new ToolError(`unknown http_log action: ${String(params.action)}`);
		}
	}
}
