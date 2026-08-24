import { afterEach, describe, expect, it } from "bun:test";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import type { RelayBridge, RelaySocket } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/bridge";
import type { RelayRpcRequest, RelayToExtMessage } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import { type RelayServer, startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";

const EXTENSION_HELLO = {
	t: "hello",
	userAgent: "test",
	browserVersion: "Chrome/151.0.0.0",
	tabs: [],
	attachedTabIds: [],
} as const;

async function rawGet(port: number, requestBytes: string): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let response = "";
	await Bun.connect({
		hostname: "127.0.0.1",
		port,
		socket: {
			open(socket) {
				socket.write(requestBytes);
			},
			data(_socket, chunk) {
				response += chunk.toString("latin1");
			},
			error(_socket, error) {
				reject(error);
			},
			close() {
				resolve(response);
			},
		},
	});
	return promise;
}

function decodeChunkedBody(body: string): string {
	let decoded = "";
	let offset = 0;
	while (true) {
		const lineEnd = body.indexOf("\r\n", offset);
		if (lineEnd === -1) throw new Error("Invalid chunked response: missing chunk size");
		const lengthText = body.slice(offset, lineEnd).split(";", 1)[0]!;
		const length = Number.parseInt(lengthText, 16);
		if (!Number.isFinite(length) || length < 0) throw new Error("Invalid chunked response: invalid chunk size");
		offset = lineEnd + 2;
		if (length === 0) return decoded;
		if (body.length < offset + length + 2) throw new Error("Invalid chunked response: truncated chunk");
		decoded += body.slice(offset, offset + length);
		offset += length;
		if (body.slice(offset, offset + 2) !== "\r\n")
			throw new Error("Invalid chunked response: missing chunk terminator");
		offset += 2;
	}
}

function parseVersion(response: string): Record<string, string> {
	const boundary = response.indexOf("\r\n\r\n");
	if (boundary === -1) throw new Error("Invalid HTTP response: missing header boundary");
	const headers = response.slice(0, boundary);
	const body = response.slice(boundary + 4);
	expect(headers).toContain("200");
	return JSON.parse(/\r\ntransfer-encoding:\s*chunked\b/i.test(headers) ? decodeChunkedBody(body) : body) as Record<
		string,
		string
	>;
}

async function connectExtension(port: number): Promise<WebSocket> {
	const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
	ws.addEventListener(
		"open",
		() => {
			ws.send(JSON.stringify(EXTENSION_HELLO));
			resolve(ws);
		},
		{ once: true },
	);
	ws.addEventListener("error", () => reject(new Error("Extension socket failed to connect")), { once: true });
	return promise;
}

async function waitForDiscovery(port: number): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (Date.now() < deadline) {
		const response = await fetch(`http://127.0.0.1:${port}/json/version`);
		if (response.status === 200) return;
	}
	throw new Error("Relay discovery endpoint did not become ready");
}

describe("browser relay discovery endpoint", () => {
	let relay: RelayServer | undefined;
	let extension: WebSocket | undefined;

	afterEach(() => {
		extension?.close();
		relay?.stop();
		extension = undefined;
		relay = undefined;
	});

	async function startReadyRelay(): Promise<number> {
		const port = await findFreeCdpPort();
		relay = startRelayServer({ port });
		extension = await connectExtension(port);
		await waitForDiscovery(port);
		return port;
	}

	it("advertises the requested Host authority so a remote Puppeteer client dials the relay", async () => {
		const port = await startReadyRelay();
		const response = await rawGet(
			port,
			"GET /json/version HTTP/1.1\r\nHost: 100.100.92.97:12803\r\nConnection: close\r\n\r\n",
		);
		expect(parseVersion(response).webSocketDebuggerUrl).toBe("ws://100.100.92.97:12803/cdp");
	});

	it("uses the loopback discovery URL when an HTTP/1.0 request has no Host header", async () => {
		const port = await startReadyRelay();
		const response = await rawGet(port, "GET /json/version HTTP/1.0\r\n\r\n");
		expect(parseVersion(response).webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${port}/cdp`);
	});

	it("uses the loopback discovery URL when Host is empty", async () => {
		const port = await startReadyRelay();
		const response = await rawGet(port, "GET /json/version HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n");
		expect(parseVersion(response).webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${port}/cdp`);
	});

	it("uses the loopback discovery URL when Host would produce an unusable WebSocket authority", async () => {
		const port = await startReadyRelay();
		const response = await rawGet(
			port,
			"GET /json/version HTTP/1.1\r\nHost: bad/host@evil\r\nConnection: close\r\n\r\n",
		);
		expect(parseVersion(response).webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${port}/cdp`);
	});

	it("reports 503 while the extension handshake is pending so the relay daemon keeps polling", async () => {
		const port = await findFreeCdpPort();
		relay = startRelayServer({ port });
		const response = await fetch(`http://127.0.0.1:${port}/json/version`);
		expect(response.status).toBe(503);
	});
});
/** Minimal relay→extension socket capturing RPCs for {@link ackBridge}. */
class FakeExtSocket implements RelaySocket {
	readonly messages: RelayToExtMessage[] = [];
	readonly #acked = new Set<number>();
	send(text: string): void {
		this.messages.push(JSON.parse(text) as RelayToExtMessage);
	}
	close(): void {}
	rpcs<Op extends RelayRpcRequest["op"]>(
		op: Op,
	): Array<{ t: "rpc"; id: number } & Extract<RelayRpcRequest, { op: Op }>> {
		return this.messages.filter(
			(msg): msg is { t: "rpc"; id: number } & Extract<RelayRpcRequest, { op: Op }> =>
				msg.t === "rpc" && msg.op === op,
		);
	}
	pending<Op extends RelayRpcRequest["op"]>(
		op: Op,
	): Array<{ t: "rpc"; id: number } & Extract<RelayRpcRequest, { op: Op }>> {
		return this.rpcs(op).filter(msg => !this.#acked.has(msg.id));
	}
	markAcked(id: number): void {
		this.#acked.add(id);
	}
}

/** Downstream CDP socket capturing bridge replies (result passthrough only). */
class FakeCdpSocket implements RelaySocket {
	readonly messages: Array<Record<string, unknown>> = [];
	send(text: string): void {
		this.messages.push(JSON.parse(text) as Record<string, unknown>);
	}
	close(): void {}
}

/** Answer every unanswered extension RPC of `op` with `ok: true` and `result`. */
function ackBridge(bridge: RelayBridge, socket: FakeExtSocket, op: RelayRpcRequest["op"], result: unknown = {}): void {
	for (const rpc of socket.pending(op)) {
		socket.markAcked(rpc.id);
		bridge.extMessage(socket, JSON.stringify({ t: "rpcResult", id: rpc.id, ok: true, result }));
	}
}

/** Flush the rpc .then() microtask chains (no timers involved). */
async function flushBridge(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

const CAPTURE_TAB = {
	tabId: 5,
	url: "http://127.0.0.1:8899/",
	title: "Target",
	active: false,
	windowId: 1,
	pinned: false,
	groupId: -1,
} as const;

describe("browser relay capture endpoint", () => {
	let relay: RelayServer | undefined;

	afterEach(() => {
		relay?.stop();
		relay = undefined;
	});

	/** Populate the bridge ring with one captured interaction via fake sockets. */
	async function populateOneCapture(): Promise<void> {
		const bridge = relay!.bridge;
		const ext = new FakeExtSocket();
		bridge.extConnected(ext);
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "Chrome/151.0.0.0",
				tabs: [CAPTURE_TAB],
				attachedTabIds: [],
			}),
		);
		const cdp = new FakeCdpSocket();
		const connId = bridge.cdpConnected(cdp);
		bridge.cdpMessage(
			connId,
			JSON.stringify({ id: 1, method: "Target.createTarget", params: { url: CAPTURE_TAB.url } }),
		);
		ackBridge(bridge, ext, "createTab", { tab: CAPTURE_TAB });
		await flushBridge();
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "cdpEvent",
				tabId: CAPTURE_TAB.tabId,
				method: "Network.requestWillBeSent",
				params: {
					requestId: "r1",
					documentURL: CAPTURE_TAB.url,
					request: { method: "GET", url: "http://127.0.0.1:8899/a" },
				},
			}),
		);
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "cdpEvent",
				tabId: CAPTURE_TAB.tabId,
				method: "Network.responseReceived",
				params: { requestId: "r1", response: { status: 200, mimeType: "text/html" } },
			}),
		);
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "cdpEvent",
				tabId: CAPTURE_TAB.tabId,
				method: "Network.loadingFinished",
				params: { requestId: "r1" },
			}),
		);
		ackBridge(bridge, ext, "send", { body: "<html>captured</html>", base64Encoded: false });
		await flushBridge();
	}

	it("serves captured records as NDJSON with the dropped header and respects the since cursor", async () => {
		const port = await findFreeCdpPort();
		relay = startRelayServer({ port });
		await populateOneCapture();

		const response = await fetch(`http://127.0.0.1:${port}/captures?since=0`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/x-ndjson");
		expect(response.headers.get("x-omp-captures-dropped")).toBe("0");
		const lines = (await response.text()).trim().split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		const rec = JSON.parse(lines[0]!) as {
			seq: number;
			url: string;
			method: string;
			status: number;
			body: string;
			pageUrl: string;
		};
		expect(rec.url).toBe("http://127.0.0.1:8899/a");
		expect(rec.method).toBe("GET");
		expect(rec.status).toBe(200);
		expect(rec.body).toBe("<html>captured</html>");
		expect(rec.pageUrl).toBe(CAPTURE_TAB.url);

		// Cursor at the drained seq: nothing left to serve.
		const drained = await fetch(`http://127.0.0.1:${port}/captures?since=${rec.seq}`);
		expect((await drained.text()).trim()).toBe("");

		// Non-numeric since → 400.
		const bad = await fetch(`http://127.0.0.1:${port}/captures?since=abc`);
		expect(bad.status).toBe(400);
	});
});
