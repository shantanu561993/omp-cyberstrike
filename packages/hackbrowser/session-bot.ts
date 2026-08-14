#!/usr/bin/env node
/**
 * Session-guardian bot (OMP-authored, MIT) for the web-pentest capability.
 *
 * Keeps an exported per-role browser session alive: probes an authenticated
 * endpoint every N seconds with the current cookie jar; when the session dies
 * (non-2xx, redirect-to-login, or content-length drift beyond tolerance) it
 * re-authenticates by replaying the recorded login flow and atomically
 * refreshes cookies.txt/headers.json.
 *
 * CLI: node dist/session-bot.mjs --session <dir> --probe <url>
 *                                 [--interval <sec>] [--drift <0-1>]
 *
 * <dir> (the per-role session dir) must contain:
 *   cookies.txt      Netscape cookie jar (written by crawl.ts --session-out)
 *   flow.json        { url, method, params: {name: value} } — the captured
 *                    login POST (replayed verbatim for re-auth)
 *   credentials.json { role, username, password } — provenance/fallback creds
 * The bot appends one JSONL line per tick to <dir>/bot.log.
 *
 * Exit codes: 0 stopped, 1 usage/startup error, 2 fatal (3 reauth failures or
 * 5 consecutive transient network errors).
 */
import * as fs from "node:fs";
import * as path from "node:path";

interface BotArgs {
	sessionDir: string;
	probe: string;
	intervalSec: number;
	drift: number;
}

function parseArgs(argv: string[]): BotArgs {
	const args: Partial<BotArgs> = {};
	const next = (i: number, flag: string): string => {
		const v = argv[i + 1];
		if (!v || v.startsWith("--")) throw new Error(`${flag} requires a value`);
		return v;
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		switch (a) {
			case "--session":
				args.sessionDir = next(i, "--session");
				i++;
				break;
			case "--probe":
				args.probe = next(i, "--probe");
				i++;
				break;
			case "--interval":
				args.intervalSec = Number.parseInt(next(i, "--interval"), 10);
				i++;
				break;
			case "--drift":
				args.drift = Number.parseFloat(next(i, "--drift"));
				i++;
				break;
			default:
				throw new Error(`unknown argument: ${a}`);
		}
	}
	if (!args.sessionDir || !args.probe) throw new Error("--session and --probe are required");
	args.intervalSec ??= 15;
	args.drift ??= 0.25;
	if (args.intervalSec < 1) throw new Error("--interval must be >= 1");
	if (args.drift <= 0 || args.drift >= 1) throw new Error("--drift must be in (0,1)");
	return args as BotArgs;
}

// --- cookie jar helpers ------------------------------------------------------

function readJar(dir: string): string {
	const p = path.join(dir, "cookies.txt");
	if (!fs.existsSync(p)) throw new Error(`missing ${p} — run crawl.ts with --session-out first`);
	return fs.readFileSync(p, "utf8");
}

/** Build a Cookie header value from the jar (name=value pairs, last wins). */
function cookieHeader(jar: string): string {
	const pairs = new Map<string, string>();
	for (const line of jar.split(/\r?\n/)) {
		if (!line || line.startsWith("#")) continue;
		const parts = line.split("\t");
		if (parts.length < 7) continue;
		const name = parts[5];
		const value = parts[6];
		if (name) pairs.set(name, value);
	}
	return [...pairs.entries()].map(([n, v]) => `${n}=${v}`).join("; ");
}

function updateJarForSetCookie(jar: string, setCookies: string[], host: string): string {
	let out = jar;
	for (const sc of setCookies) {
		const [pair] = sc.split(";");
		if (!pair) continue;
		const eq = pair.indexOf("=");
		if (eq <= 0) continue;
		const name = pair.slice(0, eq).trim();
		const value = pair.slice(eq + 1).trim();
		const lines = out.split("\n").filter(l => !l.startsWith("#") && l.split("\t").length >= 7);
		let replaced = false;
		const next = lines.map(l => {
			const parts = l.split("\t");
			if (parts[5] === name) {
				replaced = true;
				parts[6] = value;
				return parts.join("\t");
			}
			return l;
		});
		if (replaced) {
			out = next.join("\n") + (next.length ? "\n" : "");
		} else {
			// Append as a new jar line (host from the request, session cookie).
			const domain = `.${host}`;
			out += `${[domain, "TRUE", "/", "FALSE", "0", name, value].join("\t")}\n`;
		}
	}
	return out;
}

function atomicWrite(file: string, content: string): void {
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, file);
}

// --- logging -----------------------------------------------------------------

function log(dir: string, record: Record<string, unknown>): void {
	fs.appendFileSync(path.join(dir, "bot.log"), `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
}

// --- reauth ------------------------------------------------------------------

interface Flow {
	url: string;
	method: string;
	params: Record<string, string>;
}

function loadJson<T>(dir: string, name: string): T {
	const p = path.join(dir, name);
	if (!fs.existsSync(p)) throw new Error(`missing ${p}`);
	return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

async function reauth(dir: string, jar: string): Promise<{ jar: string; ok: boolean }> {
	const flow = loadJson<Flow>(dir, "flow.json");
	loadJson(dir, "credentials.json"); // provenance/fallback — required per contract
	const body = new URLSearchParams(flow.params).toString();
	const res = await fetch(flow.url, {
		method: flow.method.toUpperCase(),
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
		redirect: "manual",
		signal: AbortSignal.timeout(20_000),
	});
	const setCookies = res.headers.getSetCookie?.() ?? [];
	if (setCookies.length === 0) return { jar, ok: false };
	const updated = updateJarForSetCookie(jar, setCookies, new URL(flow.url).hostname);
	atomicWrite(path.join(dir, "cookies.txt"), updated);
	// Refresh headers.json's Cookie entry if present.
	const headersPath = path.join(dir, "headers.json");
	if (fs.existsSync(headersPath)) {
		try {
			const headers = JSON.parse(fs.readFileSync(headersPath, "utf8")) as Record<string, string>;
			if (headers.Cookie) {
				headers.Cookie = cookieHeader(updated);
				atomicWrite(headersPath, JSON.stringify(headers, null, 2));
			}
		} catch {
			/* non-JSON headers file — leave alone */
		}
	}
	return { jar: updated, ok: true };
}

// --- main loop ----------------------------------------------------------------

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const dir = args.sessionDir;
	if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
		console.error(`session dir does not exist: ${dir}`);
		process.exit(1);
	}
	// Validate required artifacts up front.
	try {
		readJar(dir);
		loadJson<Flow>(dir, "flow.json");
		loadJson(dir, "credentials.json");
	} catch (err) {
		console.error(`startup error: ${(err as Error).message}`);
		process.exit(1);
	}

	let jar = readJar(dir);
	let baselineLen = -1;
	let reauthFailures = 0;
	let transientErrors = 0;

	const tick = async (): Promise<void> => {
		const cookie = cookieHeader(jar);
		let status = 0;
		let len = 0;
		let action = "";
		try {
			const res = await fetch(args.probe, {
				headers: cookie ? { Cookie: cookie } : {},
				redirect: "manual",
				signal: AbortSignal.timeout(20_000),
			});
			const body = await res.arrayBuffer();
			status = res.status;
			len = body.byteLength;

			const redirectToLogin =
				res.status === 302 &&
				((res.headers.get("location") ?? "").includes("login") || res.status === 401 || res.status === 403);
			const drift = baselineLen > 0 ? Math.abs(len - baselineLen) / baselineLen : 0;

			if (res.status >= 500) {
				action = "transient";
				transientErrors++;
				if (transientErrors >= 5) {
					log(dir, { status, len, drift, action: "fatal", reason: "5 consecutive transient errors" });
					process.exit(2);
				}
			} else if (
				res.status === 401 ||
				res.status === 403 ||
				redirectToLogin ||
				(baselineLen > 0 && drift > args.drift)
			) {
				transientErrors = 0;
				// DEAD — re-authenticate.
				const fresh = await reauth(dir, jar).catch(err => ({ jar, ok: false, err }));
				if (fresh.ok) {
					jar = fresh.jar;
					reauthFailures = 0;
					// New baseline from the fresh session.
					const check = await fetch(args.probe, {
						headers: cookieHeader(jar) ? { Cookie: cookieHeader(jar) } : {},
						redirect: "manual",
						signal: AbortSignal.timeout(20_000),
					});
					const checkBody = await check.arrayBuffer();
					baselineLen = checkBody.byteLength;
					status = check.status;
					len = checkBody.byteLength;
					action = "reauth-ok";
				} else {
					reauthFailures++;
					action = "reauth-failed";
					if (reauthFailures >= 3) {
						log(dir, { status, len, drift, action: "fatal", reason: "3 consecutive reauth failures" });
						process.exit(2);
					}
				}
			} else {
				transientErrors = 0;
				// ALIVE — refresh artifacts if the server rotated cookies.
				const setCookies = res.headers.getSetCookie?.() ?? [];
				if (setCookies.length > 0) {
					jar = updateJarForSetCookie(jar, setCookies, new URL(args.probe).hostname);
					atomicWrite(path.join(dir, "cookies.txt"), jar);
					action = "cookies-refreshed";
				} else {
					action = "alive";
				}
				if (baselineLen < 0) baselineLen = len;
			}
			const driftOut = baselineLen > 0 ? Math.abs(len - baselineLen) / baselineLen : 0;
			log(dir, { status, len, drift: Number(driftOut.toFixed(4)), action });
		} catch (err) {
			transientErrors++;
			const msg = (err as Error).message;
			if (transientErrors >= 5) {
				log(dir, { status, len, drift: 0, action: "fatal", reason: `5 consecutive network errors: ${msg}` });
				process.exit(2);
			}
			log(dir, { status, len, drift: 0, action: "transient", error: msg.slice(0, 200) });
		}
	};

	// First baseline: keep retrying until a successful probe (never exit early).
	while (baselineLen < 0) {
		const cookie = cookieHeader(jar);
		try {
			const res = await fetch(args.probe, {
				headers: cookie ? { Cookie: cookie } : {},
				redirect: "manual",
				signal: AbortSignal.timeout(20_000),
			});
			const body = await res.arrayBuffer();
			if (res.status >= 200 && res.status < 500) {
				baselineLen = body.byteLength;
				log(dir, { status: res.status, len: body.byteLength, drift: 0, action: "baseline" });
			} else {
				log(dir, { status: res.status, len: body.byteLength, drift: 0, action: "transient" });
			}
		} catch {
			log(dir, { status: 0, len: 0, drift: 0, action: "transient" });
		}
		await new Promise(r => setTimeout(r, args.intervalSec * 1000));
	}

	setInterval(() => void tick(), args.intervalSec * 1000);
}

main().catch(err => {
	console.error(`session-bot failed: ${(err as Error).message}`);
	process.exit(2);
});
