/**
 * Bolt MCP transport — native integration for CyberStrike Bolt servers.
 *
 * Protocol port of CyberStrike `packages/cyberstrike/src/mcp/bolt-auth.ts`
 * (AGPL-3.0), source commit 71e14833cc2b003ed02837318e22bc769ddd8e21.
 * Signing format: "{timestamp}\n{nonce}\n{method}\n{path}\n{bodyHash}" signed
 * with Ed25519; headers X-Client-Id / X-Timestamp / X-Nonce / X-Signature.
 * Pairing: POST /pair (Bearer adminToken) -> {code, expiresIn,
 * serverFingerprint}; POST /pair/exchange {code, clientPublicKey, clientName}
 * -> {clientId, serverPublicKey, serverFingerprint}. Credentials live at
 * <agentDir>/bolt-keys/<name>.json (mode 0600).
 *
 * MCP surface: signed JSON-RPC POST to `${url}/mcp` (application/json or
 * text/event-stream responses).
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import type { MCPRequestOptions, MCPTransport } from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_JSON_RPC_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface BoltCredentials {
	clientId: string;
	publicKeyPem: string;
	privateKeyPem: string;
	serverPublicKeyPem: string;
	serverFingerprint: string;
	serverUrl: string;
	pairedAt: string;
}

/** SHA-256 fingerprint of a public key (first 16 hex chars) — matches the server-side function. */
export function fingerprint(publicKeyPem: string): string {
	return crypto.createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 16);
}

function generateKeypair(): { publicKeyPem: string; privateKeyPem: string } {
	const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
	return {
		publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
		privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
	};
}

// --- Credential storage ------------------------------------------------------

export function boltKeysDir(): string {
	return path.join(getAgentDir(), "bolt-keys");
}

function credPath(name: string): string {
	return path.join(boltKeysDir(), `${name}.json`);
}

export function getBoltCredentials(name: string): BoltCredentials | undefined {
	const p = credPath(name);
	if (!fs.existsSync(p)) return undefined;
	try {
		return JSON.parse(fs.readFileSync(p, "utf8")) as BoltCredentials;
	} catch {
		return undefined;
	}
}

export function saveBoltCredentials(name: string, creds: BoltCredentials): void {
	const p = credPath(name);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function deleteBoltCredentials(name: string): void {
	fs.rmSync(credPath(name), { force: true });
}

export function listBoltCredentials(): string[] {
	fs.mkdirSync(boltKeysDir(), { recursive: true });
	return fs
		.readdirSync(boltKeysDir())
		.filter((f) => f.endsWith(".json"))
		.map((f) => f.replace(/\.json$/, ""));
}

/** Find credentials whose serverUrl matches (normalized, trailing slash stripped). */
export function findBoltCredentialsByUrl(url: string): { name: string; creds: BoltCredentials } | undefined {
	const normalized = url.replace(/\/+$/, "");
	for (const name of listBoltCredentials()) {
		const creds = getBoltCredentials(name);
		if (creds && creds.serverUrl.replace(/\/+$/, "") === normalized) {
			return { name, creds };
		}
	}
	return undefined;
}

// --- Pairing -----------------------------------------------------------------

export async function pairWithBolt(
	boltName: string,
	url: string,
	adminToken: string,
): Promise<{ clientId: string; serverFingerprint: string }> {
	const baseUrl = url.replace(/\/+$/, "");
	if (!/^https?:\/\//i.test(baseUrl)) throw new Error(`bolt url must include scheme (http/https): ${url}`);

	// Step 1: request a pairing code.
	const pairRes = await fetch(`${baseUrl}/pair`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
		signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
	});
	if (!pairRes.ok) {
		const text = await pairRes.text().catch(() => "");
		throw new Error(`Pairing failed (${pairRes.status}): ${text}`);
	}
	const pairData = (await pairRes.json()) as { code: string; expiresIn: number; serverFingerprint: string };
	logger.info(`bolt pairing: received code for ${boltName} (expires in ${pairData.expiresIn}s)`);

	// Step 2: generate the client keypair; clientId is the key fingerprint.
	const keypair = generateKeypair();
	const clientId = fingerprint(keypair.publicKeyPem);

	// Step 3: exchange keys.
	const exchangeRes = await fetch(`${baseUrl}/pair/exchange`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			code: pairData.code,
			clientPublicKey: keypair.publicKeyPem,
			clientName: `omp-${boltName}`,
		}),
		signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
	});
	if (!exchangeRes.ok) {
		const text = await exchangeRes.text().catch(() => "");
		throw new Error(`Key exchange failed (${exchangeRes.status}): ${text}`);
	}
	const exchangeData = (await exchangeRes.json()) as {
		clientId: string;
		serverPublicKey: string;
		serverFingerprint: string;
	};

	const creds: BoltCredentials = {
		clientId: exchangeData.clientId,
		publicKeyPem: keypair.publicKeyPem,
		privateKeyPem: keypair.privateKeyPem,
		serverPublicKeyPem: exchangeData.serverPublicKey,
		serverFingerprint: exchangeData.serverFingerprint,
		serverUrl: baseUrl,
		pairedAt: new Date().toISOString(),
	};
	saveBoltCredentials(boltName, creds);
	logger.info(`bolt pairing complete for ${boltName}`, { clientId: creds.clientId });

	return { clientId: creds.clientId, serverFingerprint: creds.serverFingerprint };
}

// --- Request signing ---------------------------------------------------------

/** Sign headers for a request: X-Client-Id, X-Timestamp, X-Nonce, X-Signature. */
export function signRequest(
	creds: BoltCredentials,
	method: string,
	urlPath: string,
	body: string,
): Record<string, string> {
	const timestamp = new Date().toISOString();
	const nonce = crypto.randomBytes(16).toString("hex");
	const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
	const message = `${timestamp}\n${nonce}\n${method.toUpperCase()}\n${urlPath}\n${bodyHash}`;
	const privateKey = crypto.createPrivateKey(creds.privateKeyPem);
	const signature = crypto.sign(null, Buffer.from(message), privateKey);
	return {
		"X-Client-Id": creds.clientId,
		"X-Timestamp": timestamp,
		"X-Nonce": nonce,
		"X-Signature": signature.toString("base64"),
	};
}

// --- Transport ---------------------------------------------------------------

export interface BoltTransportConfig {
	url: string;
	timeout?: number;
}

export class BoltNotPairedError extends Error {
	constructor(url: string) {
		super(`bolt server ${url} is not paired — run the bolt tool: pair <url> <adminToken>`);
		this.name = "BoltNotPairedError";
	}
}

/**
 * Signed JSON-RPC transport over HTTP for Bolt servers (implements the
 * duck-typed MCPTransport contract — see mcp/types.ts).
 */
export class BoltTransport implements MCPTransport {
	readonly connected = true;
	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;

	private idCounter = 1;
	/** MCP streamable-HTTP session affinity: the server issues an Mcp-Session-Id in the
	 * initialize response and requires it on every subsequent request. */
	private sessionId: string | undefined;

	constructor(
		private readonly creds: BoltCredentials,
		private readonly config: BoltTransportConfig,
	) {}

	private async signedRequest<T>(method: string, params: Record<string, unknown>, id?: number): Promise<T> {
		const url = new URL("/mcp", this.config.url.replace(/\/+$/, ""));
		const body = JSON.stringify({
			jsonrpc: "2.0",
			id: id ?? this.idCounter++,
			method,
			params,
		});
		const headers = signRequest(this.creds, "POST", url.pathname + url.search, body);
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
				...headers,
			},
			body,
			signal: AbortSignal.timeout(this.config.timeout ?? DEFAULT_TIMEOUT_MS),
		});
		// Session affinity: remember the server-issued session id (initialize response).
		const issuedSession = res.headers.get("mcp-session-id");
		if (issuedSession) this.sessionId = issuedSession;
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`bolt ${this.config.url} responded ${res.status}: ${text.slice(0, 500)}`);
		}
		const contentType = res.headers.get("content-type") ?? "";
		let text: string;
		if (contentType.includes("text/event-stream")) {
			const raw = await res.text();
			const dataLine = raw
				.split(/\r?\n/)
				.find((l) => l.startsWith("data:"))
				?.slice(5)
				.trim();
			if (!dataLine) throw new Error(`bolt ${this.config.url}: empty SSE payload`);
			text = dataLine;
		} else {
			const buf = Buffer.from(await res.arrayBuffer());
			if (buf.byteLength > MAX_JSON_RPC_RESPONSE_BYTES) {
				throw new Error(`bolt ${this.config.url}: response exceeds ${MAX_JSON_RPC_RESPONSE_BYTES} bytes`);
			}
			text = buf.toString("utf8");
		}
		const parsed = JSON.parse(text) as { result?: T; error?: { code: number; message: string } };
		if (parsed.error) {
			throw new Error(`bolt ${method} error ${parsed.error.code}: ${parsed.error.message}`);
		}
		return parsed.result as T;
	}

	async request<T = unknown>(method: string, params?: Record<string, unknown>, options?: MCPRequestOptions): Promise<T> {
		if (options?.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Aborted");
		return this.signedRequest<T>(method, params ?? {}, undefined);
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		// Notifications have no id — the mock/real servers ignore the response.
		const url = new URL("/mcp", this.config.url.replace(/\/+$/, ""));
		const body = JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} });
		const headers = signRequest(this.creds, "POST", url.pathname + url.search, body);
		await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}), ...headers },
			body,
			signal: AbortSignal.timeout(this.config.timeout ?? DEFAULT_TIMEOUT_MS),
		}).catch(() => {});
	}

	async close(): Promise<void> {
		// Stateless HTTP transport — nothing to tear down.
	}

	setProtocolVersion(_version: string): void {
		// Bolt's JSON-RPC surface is version-agnostic.
	}
}

/** Build a BoltTransport from a server URL; throws BoltNotPairedError when unpaired. */
export function createBoltTransport(config: BoltTransportConfig): BoltTransport {
	const found = findBoltCredentialsByUrl(config.url);
	if (!found) throw new BoltNotPairedError(config.url);
	return new BoltTransport(found.creds, config);
}
