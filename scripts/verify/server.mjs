// Web pentest fixture server — verifies scanners, crawler, session export and
// the session-guardian bot. Node, no deps. Port 8090.
//   GET  /             index
//   GET  /api/user/:id  IDOR: {"id","name","secret"}
//   GET  /search?q=     unescaped echo (reflected XSS)
//   GET  /api/admin     broken authz: {"ok":true,"admin":true}
//   GET  /api/cors      reflects Origin + ACAO/ACAC: true (CORS misconfig)
//   GET  /login         HTML form (text username + password) for crawler autoLogin
//   POST /login         accepts ANY creds -> Set-Cookie session=<random>; Path=/ + 302 /
//   POST /api/expire    marks the presented session cookie expired
//   GET  /api/me        401 no cookie | 200 SHORT body when expired | 200 full body
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT ?? process.argv[2] ?? 8090);

// Session values that were explicitly expired via /api/expire.
const expiredSessions = new Set();

const FULL_BODY = JSON.stringify({ ok: true, user: "admin", role: "admin", mfa: false, plan: "enterprise" });
const SHORT_BODY = JSON.stringify({ ok: true, expired: true }); // ~27 bytes — drift signal for the session bot

function setSessionCookie(res, value) {
	res.setHeader("Set-Cookie", `session=${value}; Path=/; HttpOnly`);
}

function readSession(req) {
	const header = req.headers.cookie ?? "";
	const match = /(?:^|;\s*)session=([^;\s]+)/.exec(header);
	return match ? match[1] : null;
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url, `http://${req.headers.host}`);
	const method = req.method ?? "GET";

	if (method === "GET" && url.pathname === "/") {
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end("<html><body><h1>pentest-fixture</h1><a href=\"/login\">login</a></body></html>");
		return;
	}

	if (method === "GET" && url.pathname.startsWith("/api/user/")) {
		const id = decodeURIComponent(url.pathname.slice("/api/user/".length));
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ id, name: `user-${id}`, secret: `secret-for-${id}` }));
		return;
	}

	if (method === "GET" && url.pathname === "/search") {
		const q = url.searchParams.get("q") ?? "";
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(`<html><body><p>Results for: ${q}</p></body></html>`);
		return;
	}

	if (method === "GET" && url.pathname === "/api/admin") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true, admin: true }));
		return;
	}

	if (method === "GET" && url.pathname === "/api/cors") {
		const origin = req.headers.origin ?? "";
		if (origin) {
			res.setHeader("Access-Control-Allow-Origin", origin);
			res.setHeader("Access-Control-Allow-Credentials", "true");
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ cors: "reflects-origin" }));
		return;
	}

	if (method === "GET" && url.pathname === "/login") {
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(`<html><body><form method="POST" action="/login">
  <input type="text" name="username" />
  <input type="password" name="password" />
  <button type="submit">Sign in</button>
</form></body></html>`);
		return;
	}

	if (method === "POST" && url.pathname === "/login") {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			setSessionCookie(res, crypto.randomBytes(16).toString("hex"));
			res.writeHead(302, { Location: "/" });
			res.end();
		});
		return;
	}

	if (method === "POST" && url.pathname === "/api/expire") {
		const session = readSession(req);
		if (session) expiredSessions.add(session);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ expired: session ? true : false }));
		return;
	}

	if (method === "GET" && url.pathname === "/api/me") {
		const session = readSession(req);
		if (!session) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "unauthorized" }));
			return;
		}
		if (expiredSessions.has(session)) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(SHORT_BODY);
			return;
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(FULL_BODY);
		return;
	}

	res.writeHead(404, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => console.log(`pentest-fixture listening on ${PORT}`));
