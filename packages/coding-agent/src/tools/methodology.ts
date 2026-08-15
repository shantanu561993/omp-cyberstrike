import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, ToolTier } from "@oh-my-pi/pi-agent-core";
import {
	coverageReport,
	initMethodology,
	loadMethodology,
	type MethodologyPhaseRecord,
	missingPrerequisites,
	nextPhase,
	setPhaseState,
} from "../pentest/methodology";
import type { ToolSession } from "./index";
import { type TodoPhase, USER_TODO_EDIT_CUSTOM_TYPE } from "./todo";
import { ToolError } from "./tool-errors";

const methodologySchema = type({
	action: "'init' | 'status' | 'next' | 'start' | 'complete' | 'coverage'",
	out: "string",
	"target?": "string",
	"phase?": "string",
	"force?": "boolean",
});

type MethodologyParams = typeof methodologySchema.infer;

export interface MethodologyToolDetails {
	action: MethodologyParams["action"];
	phase?: string;
}

function renderStatusTable(phases: MethodologyPhaseRecord[]): string {
	const lines = ["Methodology status:"];
	lines.push("| Phase | Status | WSTG ids |");
	lines.push("|---|---|---|");
	for (const p of phases) {
		lines.push(`| ${p.id} | ${p.state} | ${p.wstgIds.length} |`);
	}
	return lines.join("\n");
}

// Mirror methodology transitions onto the session todo list. `done` moves only
// pending/in_progress tasks to completed; `start` moves only the FIRST pending
// task of the phase to in_progress (normalizeInProgressTask's single-in-progress
// invariant, pentest shape = one task per phase). completed/abandoned/blocked
// tasks are NEVER touched — user overrides survive. Exact phase-name match;
// missing phase, absent todo storage, or no change → silent no-op. Returns the
// number of tasks whose status changed.
function mirrorTodoStatuses(session: ToolSession, ops: Array<{ op: "start" | "done"; phaseId: string }>): number {
	const current = session.getTodoPhases?.();
	const appendEntry = session.sessionManager?.appendCustomEntry;
	if (!current || !appendEntry || ops.length === 0) return 0;
	const next: TodoPhase[] = current.map(phase => ({
		name: phase.name,
		tasks: phase.tasks.map(task =>
			task.blocker !== undefined
				? { content: task.content, status: task.status, blocker: task.blocker }
				: { content: task.content, status: task.status },
		),
	}));
	let changed = 0;
	for (const op of ops) {
		const phase = next.find(candidate => candidate.name === op.phaseId);
		if (!phase) continue;
		for (const task of phase.tasks) {
			if (op.op === "done") {
				if (task.status === "pending" || task.status === "in_progress") {
					task.status = "completed";
					changed++;
				}
			} else if (task.status === "pending") {
				task.status = "in_progress";
				changed++;
				break;
			}
		}
	}
	if (changed === 0) return 0;
	session.setTodoPhases?.(next);
	appendEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: next });
	return changed;
}

const methodologyDescription = `13-phase web pentest methodology state machine (CyberStrike phase order, OWASP WSTG 4.2 coverage). Persists <out>/methodology.json — the compaction-proof source of truth for phase progress. Actions: init (target, out; force resets), status (table of the 13 phases + states), next (first pending phase whose prerequisites are done; errors name missing prerequisites), start (phase = running), complete (phase = done), coverage (per-phase tested/total + overall %). Phases must complete in prerequisite order (e.g. passive_recon before active_recon). start/complete mirror the session todo list (phase-name match); status reconciles it automatically.`;

export class MethodologyTool implements AgentTool<typeof methodologySchema, MethodologyToolDetails> {
	readonly name = "methodology";
	readonly approval: ToolTier = "write";
	readonly label = "Methodology";
	readonly loadMode = "discoverable";
	readonly summary = "13-phase pentest methodology state machine (init/status/next/start/complete/coverage)";
	readonly description = methodologyDescription;
	readonly parameters = methodologySchema;
	readonly strict = true;

	constructor(readonly session: ToolSession) {}

	async execute(_toolCallId: string, params: MethodologyParams): Promise<AgentToolResult<MethodologyToolDetails>> {
		switch (params.action) {
			case "init": {
				const state = initMethodology(params.target ?? "", params.out, params.force);
				return {
					content: [
						{
							type: "text",
							text: `Initialized methodology for ${state.target} at ${params.out}/methodology.json (${state.phases.length} phases).\n${renderStatusTable(state.phases)}`,
						},
					],
					details: { action: "init" },
				};
			}
			case "status": {
				const state = loadMethodology(params.out);
				const ops = [
					...state.phases.filter(p => p.state === "done").map(p => ({ op: "done" as const, phaseId: p.id })),
					...state.phases.filter(p => p.state === "running").map(p => ({ op: "start" as const, phaseId: p.id })),
				];
				const reconciled = mirrorTodoStatuses(this.session, ops);
				const text =
					renderStatusTable(state.phases) +
					(reconciled > 0 ? `\n(todo reconciled: ${reconciled} task(s) updated to match methodology)` : "");
				return {
					content: [{ type: "text", text }],
					details: { action: "status" },
				};
			}
			case "next": {
				const state = loadMethodology(params.out);
				const next = nextPhase(state);
				if (!next) {
					throw new ToolError("no pending phases — methodology complete");
				}
				return {
					content: [
						{
							type: "text",
							text: `Next phase: ${next.id} — ${next.name} (${next.wstgIds.length} WSTG ids)`,
						},
					],
					details: { action: "next", phase: next.id },
				};
			}
			case "start": {
				if (!params.phase) throw new ToolError("start requires `phase`");
				const state = loadMethodology(params.out);
				const missing = missingPrerequisites(state, params.phase);
				if (missing.length > 0) {
					throw new ToolError(
						`cannot start phase '${params.phase}': prerequisites not done: ${missing.join(", ")}`,
					);
				}
				setPhaseState(params.out, params.phase, "running");
				const started = mirrorTodoStatuses(this.session, [{ op: "start", phaseId: params.phase }]);
				return {
					content: [
						{
							type: "text",
							text:
								`phase '${params.phase}' started` + (started > 0 ? `; todo '${params.phase}' in_progress` : ""),
						},
					],
					details: { action: "start", phase: params.phase },
				};
			}
			case "complete": {
				if (!params.phase) throw new ToolError("complete requires `phase`");
				const state = loadMethodology(params.out);
				const missing = missingPrerequisites(state, params.phase);
				if (missing.length > 0) {
					throw new ToolError(
						`cannot complete phase '${params.phase}': prerequisites not done: ${missing.join(", ")}`,
					);
				}
				setPhaseState(params.out, params.phase, "done");
				const completed = mirrorTodoStatuses(this.session, [{ op: "done", phaseId: params.phase }]);
				return {
					content: [
						{
							type: "text",
							text: `phase '${params.phase}' completed${completed > 0 ? `; todo '${params.phase}' done` : ""}`,
						},
					],
					details: { action: "complete", phase: params.phase },
				};
			}
			case "coverage": {
				const state = loadMethodology(params.out);
				return {
					content: [{ type: "text", text: coverageReport(state) }],
					details: { action: "coverage" },
				};
			}
			default:
				throw new ToolError(`unknown methodology action: ${String(params.action)}`);
		}
	}
}
