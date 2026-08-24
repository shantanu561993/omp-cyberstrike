import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { drainRelayCaptures } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/captures";

const RECORD_A = {
	seq: 1,
	ts: 1_700_000_000_000,
	tabId: 5,
	url: "http://127.0.0.1:8899/a",
	pageUrl: "http://127.0.0.1:8899/",
	method: "GET",
	status: 200,
	body: "<html>hi</html>",
} as const;

const RECORD_B = {
	seq: 2,
	ts: 1_700_000_000_001,
	tabId: 5,
	url: "http://127.0.0.1:8899/login",
	pageUrl: "http://127.0.0.1:8899/login",
	method: "POST",
	status: 302,
	requestBody: "user=a&pass=b",
	body: "<html>redirecting</html>",
} as const;

/** Fake relay honoring the `since` cursor like the real endpoint. */
function cursorFetch(
	records: ReadonlyArray<Record<string, unknown>>,
	dropped = 0,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
	return async (input: string | URL | Request): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const since = Number(new URL(url).searchParams.get("since") ?? "0");
		const fresh = records.filter(rec => (rec as { seq: number }).seq > since);
		return new Response(fresh.map(rec => JSON.stringify(rec)).join("\n"), {
			status: 200,
			headers: { "content-type": "application/x-ndjson", "x-omp-captures-dropped": String(dropped) },
		});
	};
}

/** Fake relay ignoring the cursor — used to prove the client's defensive skip. */
function staleFetch(
	records: ReadonlyArray<Record<string, unknown>>,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
	return async (): Promise<Response> => {
		return new Response(records.map(rec => JSON.stringify(rec)).join("\n"), {
			status: 200,
			headers: { "x-omp-captures-dropped": "0" },
		});
	};
}

describe("drainRelayCaptures", () => {
	let out: string;

	afterEach(() => {
		fs.rmSync(out, { recursive: true, force: true });
	});

	it("appends crawler-shaped requests.jsonl lines, http.log entries and response bodies, and advances the cursor", async () => {
		out = fs.mkdtempSync(path.join(os.tmpdir(), "relay-captures-"));
		const { appended } = await drainRelayCaptures(out, "http://127.0.0.1:9999/", {
			fetchImpl: cursorFetch([RECORD_A, RECORD_B]),
		});
		expect(appended).toBe(2);

		const lines = fs.readFileSync(path.join(out, "requests.jsonl"), "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		const a = JSON.parse(lines[0]!) as Record<string, unknown>;
		expect(a).toEqual({
			method: "GET",
			url: "http://127.0.0.1:8899/a",
			path: "/a",
			status: 200,
			raw: "GET http://127.0.0.1:8899/a HTTP/1.1\nHost: 127.0.0.1:8899\n\n",
			response: "<html>hi</html>",
			pageUrl: "http://127.0.0.1:8899/",
		});
		const b = JSON.parse(lines[1]!) as { path: string; raw: string; response: string };
		expect(b.path).toBe("/login");
		expect(b.raw).toContain("user=a&pass=b");
		expect(b.response).toBe("<html>redirecting</html>");

		const logLines = fs.readFileSync(path.join(out, "http.log"), "utf8").trim().split("\n");
		expect(logLines).toHaveLength(2);
		const first = JSON.parse(logLines[0]!) as {
			source: string;
			method: string;
			url: string;
			status: number;
			ref: string;
		};
		expect(first.source).toBe("browser");
		expect(first.method).toBe("GET");
		expect(first.url).toBe("http://127.0.0.1:8899/a");
		expect(first.status).toBe(200);
		expect(first.ref).toBe("requests.jsonl#1");
		const second = JSON.parse(logLines[1]!) as { ref: string; url: string };
		expect(second.ref).toBe("requests.jsonl#2");
		expect(second.url).toBe("http://127.0.0.1:8899/login");

		// Bodies land in the content-hash store, deduped like every http_log sink.
		for (const [body, url] of [
			["<html>hi</html>", "http://127.0.0.1:8899/a"],
			["<html>redirecting</html>", "http://127.0.0.1:8899/login"],
		] as const) {
			const sha = createHash("sha256").update(body).digest("hex").slice(0, 8);
			expect(fs.readFileSync(path.join(out, "responses", `${sha}.txt`), "utf8")).toBe(body);
			expect(url).toBeTruthy();
		}

		expect(JSON.parse(fs.readFileSync(path.join(out, ".relay-captures.seq"), "utf8"))).toEqual({ seq: 2 });
	});

	it("never re-appends already-drained records, even when the relay replays them", async () => {
		out = fs.mkdtempSync(path.join(os.tmpdir(), "relay-captures-"));
		await drainRelayCaptures(out, "http://127.0.0.1:9999", { fetchImpl: cursorFetch([RECORD_A, RECORD_B]) });
		// A restarted daemon replays its ring from seq 1; the cursor must hold.
		const { appended } = await drainRelayCaptures(out, "http://127.0.0.1:9999", {
			fetchImpl: staleFetch([RECORD_A, RECORD_B]),
		});
		expect(appended).toBe(0);
		const lines = fs.readFileSync(path.join(out, "requests.jsonl"), "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
	});

	it("returns appended 0 without touching artifacts when the relay is unreachable or rejects", async () => {
		out = fs.mkdtempSync(path.join(os.tmpdir(), "relay-captures-"));
		const down = await drainRelayCaptures(out, "http://127.0.0.1:1", {
			fetchImpl: async () => {
				throw new Error("connection refused");
			},
		});
		expect(down.appended).toBe(0);
		const badStatus = await drainRelayCaptures(out, "http://127.0.0.1:9999", {
			fetchImpl: async () => new Response("bad", { status: 400 }),
		});
		expect(badStatus.appended).toBe(0);
		expect(fs.existsSync(path.join(out, "requests.jsonl"))).toBe(false);
		expect(fs.existsSync(path.join(out, ".relay-captures.seq"))).toBe(false);
	});

	it("reports ring overflow through the log callback", async () => {
		out = fs.mkdtempSync(path.join(os.tmpdir(), "relay-captures-"));
		const logs: Array<{ message: string }> = [];
		await drainRelayCaptures(out, "http://127.0.0.1:9999", {
			fetchImpl: cursorFetch([RECORD_A], 3),
			log: (message: string) => logs.push({ message }),
		});
		expect(logs.some(entry => entry.message.includes("ring overflowed"))).toBe(true);
	});
});
