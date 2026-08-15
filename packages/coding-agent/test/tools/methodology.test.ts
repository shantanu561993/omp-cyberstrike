import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { TodoPhase, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { MethodologyTool, type MethodologyToolDetails } from "@oh-my-pi/pi-coding-agent/tools/methodology";

// Real pentest phase ids in prerequisite order (input_validation needs
// technology_profiling; technology_profiling needs active_recon, etc.).
const INPUT_VALIDATION_CHAIN = [
	"scope_analysis",
	"passive_recon",
	"active_recon",
	"technology_profiling",
	"input_validation",
] as const;

function stubSession(phases: TodoPhase[]): {
	session: ToolSession;
	phases(): TodoPhase[];
	entries: unknown[];
} {
	const store = structuredClone(phases);
	const entries: unknown[] = [];
	const session = {
		cwd: "/tmp",
		getTodoPhases: () => structuredClone(store),
		setTodoPhases: (next: TodoPhase[]) => {
			store.splice(0, store.length, ...structuredClone(next));
		},
		sessionManager: { appendCustomEntry: (_type: string, data: unknown) => void entries.push(data) },
	} as unknown as ToolSession;
	return { session, phases: () => structuredClone(store), entries };
}

function resultText(result: AgentToolResult<MethodologyToolDetails>): string {
	const block = result.content[0];
	return block.type === "text" ? block.text : "";
}

function todoPhase(name: string): TodoPhase {
	return { name, tasks: [{ content: name, status: "pending" }] };
}

describe("methodology tool todo mirroring", () => {
	const tmpDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(tmpDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	async function makeTool(
		phases: TodoPhase[],
	): Promise<{ tool: MethodologyTool; out: string; phases(): TodoPhase[]; entries: unknown[]; session: ToolSession }> {
		const out = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pentest-methodology-"));
		tmpDirs.push(out);
		const { session, phases: readPhases, entries } = stubSession(phases);
		const tool = new MethodologyTool(session);
		await tool.execute("test", { action: "init", target: "https://example.com", out });
		return { tool, out, phases: readPhases, entries, session };
	}

	/** Complete every phase in the given chain through the real state machine. */
	async function completeChain(tool: MethodologyTool, out: string, chain: readonly string[]): Promise<void> {
		for (const phase of chain) {
			await tool.execute("test", { action: "complete", phase, out });
		}
	}

	it("methodology complete marks the matching todo phase done and persists it", async () => {
		const { tool, out, phases, entries } = await makeTool([todoPhase("input_validation")]);
		await completeChain(tool, out, INPUT_VALIDATION_CHAIN.slice(0, -1));

		const result = await tool.execute("test", { action: "complete", phase: "input_validation", out });
		const text = resultText(result);
		expect(text).toContain("phase 'input_validation' completed");
		expect(text).toContain("; todo 'input_validation' done");

		expect(phases()[0].tasks[0].status).toBe("completed");
		expect(entries).toHaveLength(1);
		const entry = entries[0] as { phases: TodoPhase[] };
		expect(entry.phases[0].tasks[0].status).toBe("completed");
	});

	it("methodology start marks the matching todo task in_progress", async () => {
		const { tool, out, phases, entries } = await makeTool([todoPhase("input_validation")]);
		await completeChain(tool, out, INPUT_VALIDATION_CHAIN.slice(0, 4));

		const result = await tool.execute("test", { action: "start", phase: "input_validation", out });
		const text = resultText(result);
		expect(text).toContain("phase 'input_validation' started");
		expect(text).toContain("; todo 'input_validation' in_progress");

		expect(phases()[0].tasks[0].status).toBe("in_progress");
		expect(entries).toHaveLength(1);
		const entry = entries[0] as { phases: TodoPhase[] };
		expect(entry.phases[0].tasks[0].status).toBe("in_progress");
	});

	it("methodology status self-heals a desynced todo list", async () => {
		const names = ["scope_analysis", "passive_recon", "active_recon", "technology_profiling"];
		const { tool, out, session, phases, entries } = await makeTool(names.map(todoPhase));
		await completeChain(tool, out, names);

		// Desync: the session store is reset to all-pending while methodology.json
		// stays done — the next `status` must re-mirror the persisted state.
		session.setTodoPhases?.(names.map(todoPhase));

		const result = await tool.execute("test", { action: "status", out });
		expect(resultText(result)).toContain("(todo reconciled: 4 task(s) updated to match methodology)");
		expect(phases().map(phase => phase.tasks[0].status)).toEqual([
			"completed",
			"completed",
			"completed",
			"completed",
		]);
		const entry = entries[entries.length - 1] as { phases: TodoPhase[] };
		expect(entry.phases.every(phase => phase.tasks[0].status === "completed")).toBe(true);
	});

	it("unknown todo phase is a silent no-op", async () => {
		// `sweep` has no methodology equivalent — completing a methodology phase
		// must not touch it and must not create a persisted entry.
		const { tool, out, phases, entries } = await makeTool([todoPhase("sweep")]);

		const result = await tool.execute("test", { action: "complete", phase: "scope_analysis", out });
		const text = resultText(result);
		expect(text).toContain("phase 'scope_analysis' completed");
		expect(text).not.toContain("; todo");
		expect(phases()[0].tasks[0].status).toBe("pending");
		expect(entries).toHaveLength(0);
	});

	it("missing todo storage is a silent no-op", async () => {
		// Session without getTodoPhases/sessionManager: no mirroring, no error.
		const session = { cwd: "/tmp" } as unknown as ToolSession;
		const out = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pentest-methodology-"));
		tmpDirs.push(out);
		const tool = new MethodologyTool(session);
		await tool.execute("test", { action: "init", target: "https://example.com", out });

		const result = await tool.execute("test", { action: "complete", phase: "scope_analysis", out });
		expect(resultText(result)).not.toContain("; todo");
	});
});
