// Bolt protocol mock server — implements the CyberStrike Bolt pairing +
// signed-JSON-RPC MCP surface (protocol authority:
// packages/cyberstrike/src/mcp/bolt-auth.ts). Node, no deps. Port 8091.
//   POST /pair            Bearer adminToken -> {code, expiresIn, serverFingerprint}
//   POST /pair/exchange   {code, clientPublicKey, clientName} -> {clientId, serverPublicKey, serverFingerprint}
//   GET  /health          {status, version, tools, auth}
//   POST /mcp             signed JSON-RPC: initialize / tools/list / tools/call (bash via execSync)
//   --rotate             regenerate the server keypair on start (pairing invalidated)
import http from "node:http";
import crypto from "node:crypto";

const ADMIN_TOKEN = "test-admin-token";
const PORT = Number(process.env.PORT ?? process.argv[2] ?? 8091);

const { publicKey: serverKey, privateKey: serverPriv } = crypto.generateKeyPairSync("ed25519");
const serverPublicKeyPem = serverKey.export({ type: "spki", format: "pem" });
const serverPrivateKeyPem = serverPriv.export({ type: "pkcs8", format: "pem" });

function fingerprint(pem) {
	return crypto.createHash("sha256").update(pem).digest("hex").slice(0, 16);
}
const serverFingerprint = fingerprint(serverPublicKeyPem);

const pairingCodes = new Map(); // code -> { expiresAt }
const clients = new Map(); // clientId -> { publicKeyPem }

function verifySignature(req, rawBody) {
	const clientId = req.headers["x-client-id"];
	const timestamp = req.headers["x-timestamp"];
	const nonce = req.headers["x-nonce"];
	const signature = req.headers["x-signature"];
	if (!clientId || !timestamp || !nonce || !signature) return false;
	const client = clients.get(clientId);
	if (!client) return false;
	const url = new URL(req.url, `http://${req.headers.host}`);
	const path = url.pathname + url.search;
	const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
	const message = `${timestamp}\n${nonce}\n${req.method}\n${path}\n${bodyHash}`;
	try {
		const key = crypto.createPublicKey(client.publicKeyPem);
		return crypto.verify(null, Buffer.from(message), key, Buffer.from(signature, "base64"));
	} catch {
		return false;
	}
}

function json(res, status, data) {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}

function readBody(req) {
	return new Promise((resolve) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => resolve(body));
	});
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://${req.headers.host}`);
	const method = req.method ?? "GET";

	if (method === "GET" && url.pathname === "/health") {
		json(res, 200, { status: "ok", version: "1.0.0", tools: 1, auth: "ed25519" });
		return;
	}

	if (method === "POST" && url.pathname === "/pair") {
		if (req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) {
			json(res, 401, { error: "invalid admin token" });
			return;
		}
		const code = crypto.randomBytes(8).toString("hex");
		pairingCodes.set(code, { expiresAt: Date.now() + 60_000 });
		json(res, 200, { code, expiresIn: 60, serverFingerprint });
		return;
	}

	if (method === "POST" && url.pathname === "/pair/exchange") {
		const body = await readBody(req);
		const data = JSON.parse(body);
		const code = pairingCodes.get(data.code);
		if (!code || code.expiresAt < Date.now()) {
			json(res, 401, { error: "invalid or expired pairing code" });
			return;
		}
		pairingCodes.delete(data.code);
		const clientId = fingerprint(data.clientPublicKey);
		clients.set(clientId, { publicKeyPem: data.clientPublicKey });
		json(res, 200, { clientId, serverPublicKey: serverPublicKeyPem, serverFingerprint });
		return;
	}

	if (method === "POST" && url.pathname === "/mcp") {
		const raw = await readBody(req);
		if (!verifySignature(req, raw)) {
			json(res, 401, { error: "invalid signature" });
			return;
		}
		let rpc;
		try {
			rpc = JSON.parse(raw);
		} catch {
			json(res, 400, { error: "invalid JSON-RPC" });
			return;
		}
		if (rpc.method === "initialize") {
			json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "bolt-mock", version: "1.0.0" } } });
			return;
		}
		if (rpc.method === "tools/list") {
			json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "bash", description: "Run a shell command on the bolt server", inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }] } });
			return;
		}
		if (rpc.method === "tools/call") {
			const toolName = rpc.params?.name;
			const args = rpc.params?.arguments ?? {};
			if (toolName === "bash") {
				const command = String(args.command ?? "");
				const out = (await new Promise((resolve) => {
					import("node:child_process").then(({ execSync }) => {
						try {
							resolve({ ok: true, text: execSync(command, { encoding: "utf8", timeout: 10_000 }).toString() });
						} catch (err) {
							resolve({ ok: false, text: String(err.stderr ?? err.message) });
						}
					});
				}))();
				json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: out.text }], isError: !out.ok } });
				return;
			}
			json(res, 200, { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: `unknown tool: ${toolName}` }], isError: true } });
			return;
		}
		json(res, 200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: `method not found: ${rpc.method}` } });
		return;
	}

	json(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log(`bolt-mock listening on ${PORT} (fingerprint ${serverFingerprint})`));
