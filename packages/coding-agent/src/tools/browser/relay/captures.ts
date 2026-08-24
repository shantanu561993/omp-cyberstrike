/**
 * Relay traffic capture: wire record type + tool-side drain client.
 *
 * The relay bridge (sibling `bridge.ts`) records every HTTP interaction of
 * agent-driven tabs into an in-memory ring; this module drains it over HTTP
 * into the standard pentest artifacts — `<out>/requests.jsonl`,
 * `<out>/http.log`, `<out>/responses/<sha8>.txt` — the same files `web_crawl`
 * produces, so recon via the browser tool feeds every downstream consumer
 * (endpoint extraction, flow.json, guardian-bot probe, http_log queries).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { appendLogEntry } from "../../../pentest/http-log";

/** One captured HTTP interaction, as produced by the relay bridge ring. */
export interface CaptureRecord {
	/** Monotonic per-daemon sequence; the drain cursor advances past it. */
	seq: number;
	ts: number;
	tabId: number;
	url: string;
	/** URL of the page that initiated the request (main-frame document). */
	pageUrl: string;
	method: string;
	status: number;
	requestBody?: string;
	/** Response body, UTF-8, capped at `HTTP_LOG_BODY_CAP_BYTES`. */
	body?: string;
}

export interface DrainRelayCapturesOptions {
	/** Overridable for tests. */
	fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	log?: (message: string, data?: Record<string, unknown>) => void;
}

/** The drain must never hang a browser action; short deadline, then skip. */
const DRAIN_TIMEOUT_MS = 5_000;

/**
 * Drain records newer than the persisted cursor into the pentest artifacts.
 * Never throws: capture is best-effort and must not break browsing. Returns
 * how many records were appended (0 on any failure).
 */
export async function drainRelayCaptures(
	out: string,
	cdpUrl: string,
	opts: DrainRelayCapturesOptions = {},
): Promise<{ appended: number }> {
	const log = opts.log ?? (() => {});
	const fetchImpl = opts.fetchImpl ?? fetch;
	const cursorPath = path.join(out, ".relay-captures.seq");

	// Cursor: seq of the last drained record. Missing/corrupt → start over.
	let since = 0;
	try {
		const cursor = (await Bun.file(cursorPath).json()) as { seq?: unknown };
		if (typeof cursor?.seq === "number" && Number.isFinite(cursor.seq) && cursor.seq >= 0) since = cursor.seq;
	} catch {
		since = 0;
	}

	let text: string;
	let dropped = 0;
	try {
		const res = await fetchImpl(`${cdpUrl.replace(/\/+$/, "")}/captures?since=${since}`, {
			signal: AbortSignal.timeout(DRAIN_TIMEOUT_MS),
		});
		if (!res.ok) {
			log("relay capture drain failed", { status: res.status });
			return { appended: 0 };
		}
		dropped = Number(res.headers.get("x-omp-captures-dropped") ?? "0");
		text = await res.text();
	} catch (err) {
		log("relay capture drain failed", { error: err instanceof Error ? err.message : String(err) });
		return { appended: 0 };
	}
	if (dropped > 0) {
		log("relay capture ring overflowed between drains; records dropped", { dropped });
	}

	const records: CaptureRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			records.push(JSON.parse(line) as CaptureRecord);
		} catch {
			// Malformed line: skip; the cursor advances past it like any record.
		}
	}
	if (records.length === 0) return { appended: 0 };

	// requests.jsonl line numbers are the http.log refs; count existing lines.
	const outFile = path.join(out, "requests.jsonl");
	fs.mkdirSync(out, { recursive: true });
	let lineNumber = 0;
	if (fs.existsSync(outFile)) {
		const existing = fs.readFileSync(outFile, "utf8").trimEnd();
		if (existing) lineNumber = existing.split("\n").length;
	}

	let appended = 0;
	let maxSeq = since;
	for (const record of records) {
		// A restarted daemon restarts its ring at seq 1; a stale cursor would
		// otherwise re-match colliding seq values. Skip anything at/below the
		// cursor — the server contract is seq > since anyway.
		if (record.seq <= since) continue;
		let parsed: URL;
		try {
			parsed = new URL(record.url);
		} catch {
			continue;
		}
		const requestBody = record.requestBody ?? "";
		lineNumber += 1;
		const json = JSON.stringify({
			method: record.method,
			url: record.url,
			path: parsed.pathname,
			status: record.status,
			raw: `${record.method} ${record.url} HTTP/1.1\nHost: ${parsed.host}\n\n${requestBody}`,
			response: record.body ?? "",
			pageUrl: record.pageUrl,
		} satisfies {
			method: string;
			url: string;
			path: string;
			status: number;
			raw: string;
			response: string;
			pageUrl: string;
		});
		try {
			fs.appendFileSync(outFile, `${json}\n`);
			appendLogEntry(out, {
				source: "browser",
				method: record.method,
				url: record.url,
				status: record.status,
				body: record.body,
				ref: `requests.jsonl#${lineNumber}`,
			});
			appended += 1;
			maxSeq = record.seq;
		} catch (err) {
			log("relay capture append failed", { error: err instanceof Error ? err.message : String(err) });
		}
	}

	await Bun.write(cursorPath, JSON.stringify({ seq: maxSeq }));
	return { appended };
}
