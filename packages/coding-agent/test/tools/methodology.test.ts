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

describe("methodology tool does not touch the session todo list", () => {
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

	it("start/complete leave the todo list and todo entries untouched", async () => {
		const { tool, out, phases, entries } = await makeTool([todoPhase("input_validation")]);
		await completeChain(tool, out, INPUT_VALIDATION_CHAIN.slice(0, -1));

		const result = await tool.execute("test", { action: "start", phase: "input_validation", out });
		expect(resultText(result)).toContain("phase 'input_validation' started");
		expect(resultText(result)).not.toContain("todo");

		await tool.execute("test", { action: "complete", phase: "input_validation", out });
		expect(phases()[0].tasks[0].status).toBe("pending");
		expect(entries).toHaveLength(0);
	});

	it("status writes no todo entries", async () => {
		const names = ["scope_analysis", "passive_recon", "active_recon", "technology_profiling"];
		const { tool, out, phases, entries } = await makeTool(names.map(todoPhase));
		await completeChain(tool, out, names);

		const result = await tool.execute("test", { action: "status", out });
		expect(resultText(result)).not.toContain("reconciled");
		expect(phases().every(p => p.tasks[0].status === "pending")).toBe(true);
		expect(entries).toHaveLength(0);
	});

	it("missing todo storage still completes phases (no todo write attempted)", async () => {
		const session = { cwd: "/tmp" } as unknown as ToolSession;
		const out = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pentest-methodology-"));
		tmpDirs.push(out);
		const tool = new MethodologyTool(session);
		await tool.execute("test", { action: "init", target: "https://example.com", out });

		const result = await tool.execute("test", { action: "complete", phase: "scope_analysis", out });
		expect(resultText(result)).toContain("phase 'scope_analysis' completed");
		expect(resultText(result)).not.toContain("todo");
	});
});
