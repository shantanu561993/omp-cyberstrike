import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as debugSessionLog from "@oh-my-pi/pi-coding-agent/debug/session-debug-log";
import { MethodologyTool } from "@oh-my-pi/pi-coding-agent/tools/methodology";
import { getLogsDir } from "@oh-my-pi/pi-utils";
import * as logger from "@oh-my-pi/pi-utils/logger";

const tmpDirs: string[] = [];
const mocks: Array<{ mockRestore(): void }> = [];

afterEach(async () => {
	delete process.env.PI_DEBUG_SESSION_LOG;
	for (const mock of mocks.splice(0)) mock.mockRestore();
	debugSessionLog.setSessionTraceEnabled(true);
	debugSessionLog.setDebugLogDir(undefined);
	logger.setTransports({ file: true });
	await Promise.all(tmpDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tmpDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-debug-log-"));
	tmpDirs.push(dir);
	return dir;
}

describe("session debug log gate", () => {
	it("defaults on, the setting turns it off, and the env hard-off wins", () => {
		delete process.env.PI_DEBUG_SESSION_LOG;
		debugSessionLog.setSessionTraceEnabled(true);
		expect(debugSessionLog.sessionDebugLogEnabled()).toBe(true);

		debugSessionLog.setSessionTraceEnabled(false);
		expect(debugSessionLog.sessionDebugLogEnabled()).toBe(false);

		process.env.PI_DEBUG_SESSION_LOG = "0";
		debugSessionLog.setSessionTraceEnabled(true);
		expect(debugSessionLog.sessionDebugLogEnabled()).toBe(false);
	});

	it("debug log dir defaults to the global dir and honors the override", async () => {
		debugSessionLog.setDebugLogDir(undefined);
		expect(debugSessionLog.debugLogDir()).toBe(path.join(getLogsDir(), "debug"));

		const dir = await tmpDir();
		debugSessionLog.setDebugLogDir(dir);
		expect(debugSessionLog.debugLogDir()).toBe(dir);

		debugSessionLog.setDebugLogDir(undefined);
		expect(debugSessionLog.debugLogDir()).toBe(path.join(getLogsDir(), "debug"));
	});

	it("writes the session trace into the override dir, not the global logs dir", async () => {
		process.env.PI_DEBUG_SESSION_LOG = "1";
		const dir = await tmpDir();
		debugSessionLog.setDebugLogDir(dir);

		debugSessionLog.dumpRawSseToDisk("", "sess", "label");

		const tracePath = path.join(dir, `debug-session.${process.pid}.log`);
		// appendLine writes through a fire-and-forget promise chain with no
		// exposed signal; yield to the event loop (zero wall-clock delay) until
		// the file appears.
		for (let i = 0; i < 1_000 && !(await Bun.file(tracePath).exists()); i++) {
			await Bun.sleep(0);
		}
		expect(await Bun.file(tracePath).text()).toContain("raw_sse_dump_skipped");
		expect(await Bun.file(tracePath).text()).toContain('"sessionId":"sess"');

		// Co-located suites share the process: an earlier test may already have
		// written a global trace file (default-on). Assert OUR dump never landed
		// there via the unique session id, not via file absence.
		const globalTrace = path.join(getLogsDir(), "debug", `debug-session.${process.pid}.log`);
		const globalText = (await Bun.file(globalTrace).exists()) ? await Bun.file(globalTrace).text() : "";
		expect(globalText).not.toContain('"sessionId":"sess"');
	});
});

describe("methodology init redirects both debug sinks", () => {
	it("points the session-trace dir and logger file transport at <out>/debug", async () => {
		const dir = await tmpDir();
		const setDirSpy = spyOn(debugSessionLog, "setDebugLogDir");
		const setTransportsSpy = spyOn(logger, "setTransports");
		mocks.push(setDirSpy, setTransportsSpy);

		const tool = new MethodologyTool({} as never);
		await tool.execute("id", { action: "init", target: "https://x", out: dir });

		expect(setDirSpy).toHaveBeenCalledWith(path.join(dir, "debug"));
		expect(setTransportsSpy).toHaveBeenCalledWith({ file: path.join(dir, "debug") });
	});
});
