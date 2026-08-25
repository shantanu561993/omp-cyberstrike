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

const methodologyDescription = `13-phase web pentest methodology state machine (CyberStrike phase order, OWASP WSTG 4.2 coverage). Persists <out>/methodology.json — the compaction-proof source of truth for phase progress. Actions: init (target, out; force resets), status (table of the 13 phases + states), next (first pending phase whose prerequisites are done; errors name missing prerequisites), start (phase = running), complete (phase = done), coverage (per-phase tested/total + overall %). Phases must complete in prerequisite order (e.g. passive_recon before active_recon). Phase state lives only in <out>/methodology.json; the orchestrator maintains the session todo list itself via the todo tool.`;

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
				return {
					content: [{ type: "text", text: renderStatusTable(state.phases) }],
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
				return {
					content: [{ type: "text", text: `phase '${params.phase}' started` }],
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
				return {
					content: [{ type: "text", text: `phase '${params.phase}' completed` }],
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
