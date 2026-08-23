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
import type { MCPFetchInit } from "./transports/header-policy";
import { HttpTransport } from "./transports/http";

const DEFAULT_TIMEOUT_MS = 15_000;

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
		.filter(f => f.endsWith(".json"))
		.map(f => f.replace(/\.json$/, ""));
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

	// Step 2: generate the client keypair.
	const keypair = generateKeypair();

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
 * Signed JSON-RPC transport over HTTP for Bolt servers.
 *
 * Rides the shared streamable-HTTP transport (`mcp/transports/http.ts`): MCP
 * session affinity, SSE response handling, server-to-client requests,
 * timeouts, and DELETE session termination come from upstream. The
 * bolt-specific parts: the per-request Ed25519 signature (injected through
 * the request-header hook) and three wire-surface overrides that keep the
 * bolt protocol exactly as the client verified against real CyberStrike
 * Bolt servers — no MCP-Protocol-Version header, no GET SSE listener, and
 * notification failures that must not kill the connection (the original
 * bolt client sent notifications fire-and-forget).
 */
export class BoltTransport extends HttpTransport {
	constructor(creds: BoltCredentials, config: BoltTransportConfig) {
		// Preserve the absolute-path `/mcp` endpoint the CyberStrike server
		// expects: an origin-prefixed base URL still targets `/mcp` at the
		// origin root, and the signature covers exactly the path requested.
		const url = new URL("/mcp", config.url.replace(/\/+$/, "")).href;
		super({ type: "http", url, timeout: config.timeout }, (init: MCPFetchInit) =>
			signRequest(creds, init.method, new URL(url).pathname + new URL(url).search, init.body ?? ""),
		);
	}

	/** Bolt's JSON-RPC surface is version-agnostic — never send MCP-Protocol-Version. */
	override setProtocolVersion(_version: string): void {}

	/** The bolt protocol has no GET SSE listener (signed POSTs only). */
	override async startSSEListener(): Promise<void> {}

	/**
	 * Notifications are fire-and-forget on bolt servers: a rejected
	 * `notifications/initialized` must not fail the connection (the original
	 * bolt client swallowed these errors).
	 */
	override async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		try {
			await super.notify(method, params);
		} catch (err) {
			logger.debug("bolt notification failed (non-fatal)", {
				method,
				url: this.url,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

/** Build a connected BoltTransport from a server URL; throws BoltNotPairedError when unpaired. */
export async function createBoltTransport(config: BoltTransportConfig): Promise<BoltTransport> {
	const found = findBoltCredentialsByUrl(config.url);
	if (!found) throw new BoltNotPairedError(config.url);
	const transport = new BoltTransport(found.creds, config);
	await transport.connect();
	return transport;
}
