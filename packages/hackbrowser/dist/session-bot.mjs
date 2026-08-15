#!/usr/bin/env node

// session-bot.ts
import * as fs from "node:fs";
import * as path from "node:path";
function parseArgs(argv) {
  const args = {};
  const next = (i, flag) => {
    const v = argv[i + 1];
    if (!v || v.startsWith("--"))
      throw new Error(`${flag} requires a value`);
    return v;
  };
  for (let i = 0;i < argv.length; i++) {
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
  if (!args.sessionDir || !args.probe)
    throw new Error("--session and --probe are required");
  args.intervalSec ??= 15;
  args.drift ??= 0.25;
  if (args.intervalSec < 1)
    throw new Error("--interval must be >= 1");
  if (args.drift <= 0 || args.drift >= 1)
    throw new Error("--drift must be in (0,1)");
  return args;
}
function readJar(dir) {
  const p = path.join(dir, "cookies.txt");
  if (!fs.existsSync(p))
    throw new Error(`missing ${p} — run crawl.ts with --session-out first`);
  return fs.readFileSync(p, "utf8");
}
function cookieHeader(jar) {
  const pairs = new Map;
  for (const line of jar.split(/\r?\n/)) {
    if (!line || line.startsWith("#"))
      continue;
    const parts = line.split("\t");
    if (parts.length < 7)
      continue;
    const name = parts[5];
    const value = parts[6];
    if (name)
      pairs.set(name, value);
  }
  return [...pairs.entries()].map(([n, v]) => `${n}=${v}`).join("; ");
}
function updateJarForSetCookie(jar, setCookies, host) {
  let out = jar;
  for (const sc of setCookies) {
    const [pair] = sc.split(";");
    if (!pair)
      continue;
    const eq = pair.indexOf("=");
    if (eq <= 0)
      continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const lines = out.split(`
`).filter((l) => !l.startsWith("#") && l.split("\t").length >= 7);
    let replaced = false;
    const next = lines.map((l) => {
      const parts = l.split("\t");
      if (parts[5] === name) {
        replaced = true;
        parts[6] = value;
        return parts.join("\t");
      }
      return l;
    });
    if (replaced) {
      out = next.join(`
`) + (next.length ? `
` : "");
    } else {
      const domain = `.${host}`;
      out += `${[domain, "TRUE", "/", "FALSE", "0", name, value].join("\t")}
`;
    }
  }
  return out;
}
function atomicWrite(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}
function log(dir, record) {
  fs.appendFileSync(path.join(dir, "bot.log"), `${JSON.stringify({ ts: new Date().toISOString(), ...record })}
`);
}
function loadJson(dir, name) {
  const p = path.join(dir, name);
  if (!fs.existsSync(p))
    throw new Error(`missing ${p}`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
async function reauth(dir, jar) {
  const flow = loadJson(dir, "flow.json");
  loadJson(dir, "credentials.json");
  const body = new URLSearchParams(flow.params).toString();
  const res = await fetch(flow.url, {
    method: flow.method.toUpperCase(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(20000)
  });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  if (setCookies.length === 0)
    return { jar, ok: false };
  const updated = updateJarForSetCookie(jar, setCookies, new URL(flow.url).hostname);
  atomicWrite(path.join(dir, "cookies.txt"), updated);
  const headersPath = path.join(dir, "headers.json");
  if (fs.existsSync(headersPath)) {
    try {
      const headers = JSON.parse(fs.readFileSync(headersPath, "utf8"));
      if (headers.Cookie) {
        headers.Cookie = cookieHeader(updated);
        atomicWrite(headersPath, JSON.stringify(headers, null, 2));
      }
    } catch {}
  }
  return { jar: updated, ok: true };
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.sessionDir;
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`session dir does not exist: ${dir}`);
    process.exit(1);
  }
  try {
    readJar(dir);
    loadJson(dir, "flow.json");
    loadJson(dir, "credentials.json");
  } catch (err) {
    console.error(`startup error: ${err.message}`);
    process.exit(1);
  }
  let jar = readJar(dir);
  let baselineLen = -1;
  let reauthFailures = 0;
  let transientErrors = 0;
  const tick = async () => {
    const cookie = cookieHeader(jar);
    let status = 0;
    let len = 0;
    let action = "";
    try {
      const res = await fetch(args.probe, {
        headers: cookie ? { Cookie: cookie } : {},
        redirect: "manual",
        signal: AbortSignal.timeout(20000)
      });
      const body = await res.arrayBuffer();
      status = res.status;
      len = body.byteLength;
      const redirectToLogin = res.status === 302 && ((res.headers.get("location") ?? "").includes("login") || res.status === 401 || res.status === 403);
      const drift = baselineLen > 0 ? Math.abs(len - baselineLen) / baselineLen : 0;
      if (res.status >= 500) {
        action = "transient";
        transientErrors++;
        if (transientErrors >= 5) {
          log(dir, { status, len, drift, action: "fatal", reason: "5 consecutive transient errors" });
          process.exit(2);
        }
      } else if (res.status === 401 || res.status === 403 || redirectToLogin || baselineLen > 0 && drift > args.drift) {
        transientErrors = 0;
        const fresh = await reauth(dir, jar).catch((err) => ({ jar, ok: false, err }));
        if (fresh.ok) {
          jar = fresh.jar;
          reauthFailures = 0;
          const check = await fetch(args.probe, {
            headers: cookieHeader(jar) ? { Cookie: cookieHeader(jar) } : {},
            redirect: "manual",
            signal: AbortSignal.timeout(20000)
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
        const setCookies = res.headers.getSetCookie?.() ?? [];
        if (setCookies.length > 0) {
          jar = updateJarForSetCookie(jar, setCookies, new URL(args.probe).hostname);
          atomicWrite(path.join(dir, "cookies.txt"), jar);
          action = "cookies-refreshed";
        } else {
          action = "alive";
        }
        if (baselineLen < 0)
          baselineLen = len;
      }
      const driftOut = baselineLen > 0 ? Math.abs(len - baselineLen) / baselineLen : 0;
      log(dir, { status, len, drift: Number(driftOut.toFixed(4)), action });
    } catch (err) {
      transientErrors++;
      const msg = err.message;
      if (transientErrors >= 5) {
        log(dir, { status, len, drift: 0, action: "fatal", reason: `5 consecutive network errors: ${msg}` });
        process.exit(2);
      }
      log(dir, { status, len, drift: 0, action: "transient", error: msg.slice(0, 200) });
    }
  };
  while (baselineLen < 0) {
    const cookie = cookieHeader(jar);
    try {
      const res = await fetch(args.probe, {
        headers: cookie ? { Cookie: cookie } : {},
        redirect: "manual",
        signal: AbortSignal.timeout(20000)
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
    await new Promise((r) => setTimeout(r, args.intervalSec * 1000));
  }
  setInterval(() => void tick(), args.intervalSec * 1000);
}
main().catch((err) => {
  console.error(`session-bot failed: ${err.message}`);
  process.exit(2);
});
