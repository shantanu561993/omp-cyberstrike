/**
 * Debug-build session trace.
 *
 * Writes every user prompt, assistant message (thinking + text + tool calls),
 * tool result (with error flags), and lifecycle event as JSONL to
 * `<logs>/debug-session.<pid>.log`, plus per-turn raw provider SSE frames to
 * `<logs>/debug-raw-sse.<pid>.log`. Enabled by `PI_DEBUG_SESSION_LOG=1` on any
 * build, or unconditionally by the `PI_DEBUG_BUILD` define baked into debug
 * binaries (see scripts/compile-binary.ts).
 *
 * The tee runs in `AgentSession.#emitSessionEvent` — after the message is
 * committed but before subscriber fan-out — so records observe the same
 * messages the TUI/RPC saw. Writes are queued off the hot path; a failed
 * write never disturbs the session.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { getLogsDir } from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent } from "../session/agent-session-events";

/** Longest single serialized field (thinking block, tool args, result text). */
const MAX_FIELD_CHARS = 16_000;

/** True on any build when the env var is set; always true in debug binaries. */
export function sessionDebugLogEnabled(): boolean {
	return process.env.PI_DEBUG_SESSION_LOG === "1" || process.env.PI_DEBUG_BUILD === "1";
}

function debugLogDir(): string {
	return path.join(getLogsDir(), "debug");
}

function sessionLogPath(): string {
	return path.join(debugLogDir(), `debug-session.${process.pid}.log`);
}

function rawSseLogPath(): string {
	return path.join(debugLogDir(), `debug-raw-sse.${process.pid}.log`);
}

/** Serialized-write queue; append failures are swallowed (debug aid only). */
let writeChain: Promise<void> = Promise.resolve();

function appendLine(file: string, line: string): void {
	const write = async () => {
		// fs.appendFile does not create parent directories; the debug/ subdir
		// is created lazily on the first write of the process.
		await fs.mkdir(debugLogDir(), { recursive: true });
		await fs.appendFile(file, `${line}\n`);
	};
	writeChain = writeChain.then(write).catch(() => {
		// Debug-only: a full disk or locked file must not break the session.
	});
}

/** Write the raw provider SSE ring buffer snapshot (per turn / on dispose). */
export function dumpRawSseToDisk(rawText: string, sessionId: string, label: string): void {
	if (!sessionDebugLogEnabled()) return;
	if (rawText.trim().length === 0) {
		appendLine(
			sessionLogPath(),
			JSON.stringify({ t: "raw_sse_dump_skipped", label, sessionId, reason: "empty buffer" }),
		);
		return;
	}
	const header = `\n===== ${label} session=${sessionId} pid=${process.pid} ${new Date().toISOString()} =====\n`;
	appendLine(rawSseLogPath(), `${header}${rawText}`);
}

function truncateText(text: string): string {
	if (text.length <= MAX_FIELD_CHARS) return text;
	return `${text.slice(0, MAX_FIELD_CHARS)}\n…[+${text.length - MAX_FIELD_CHARS} chars truncated]`;
}

/** JSON-serialize a value, truncating oversized payloads. */
function jsonOf(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	try {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) return undefined;
		return serialized.length > MAX_FIELD_CHARS ? truncateText(serialized) : serialized;
	} catch {
		return `[unserializable: ${typeof value}]`;
	}
}

function textOfContent(content: unknown): string | undefined {
	if (typeof content === "string") return truncateText(content);
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; text?: string };
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		else if (b.type === "image") parts.push("[image]");
	}
	return parts.length > 0 ? truncateText(parts.join("\n")) : undefined;
}

function messageRecord(message: AgentMessage): Record<string, unknown> {
	// AgentMessage extends the pi-ai Message union with app-specific custom
	// message types — guard on the role field and fall back to a raw dump.
	if (!message || typeof message !== "object" || !("role" in message) || typeof message.role !== "string") {
		return { raw: jsonOf(message) };
	}
	const base: Record<string, unknown> = {};
	// Narrow to the pi-ai message shapes below; the role check above makes
	// this cast safe for every Message member.
	const msg = message as unknown as Message;
	base.role = msg.role;
	base.ts = msg.timestamp;
	message = msg;
	if (message.role === "user" || message.role === "developer") {
		const m = message as UserMessage;
		base.text = textOfContent(m.content);
		base.synthetic = m.synthetic === true ? true : undefined;
		return base;
	}
	if (message.role === "assistant") {
		const m = message as AssistantMessage;
		const thinking: string[] = [];
		const text: string[] = [];
		const toolCalls: Array<{ id?: string; name?: string; args?: unknown }> = [];
		for (const block of m.content) {
			if (block.type === "thinking") thinking.push(block.thinking);
			else if (block.type === "text") text.push(block.text);
			else if (block.type === "toolCall") {
				toolCalls.push({ id: block.id, name: block.name, args: block.arguments });
			}
		}
		base.thinking = thinking.length > 0 ? truncateText(thinking.join("\n")) : undefined;
		base.text = text.length > 0 ? truncateText(text.join("\n")) : undefined;
		base.toolCalls = toolCalls.length > 0 ? jsonOf(toolCalls) : undefined;
		base.model = m.model;
		base.stopReason = m.stopReason;
		base.errorMessage = m.errorMessage;
		base.errorStatus = m.errorStatus;
		base.errorId = m.errorId;
		base.usage = m.usage ? jsonOf(m.usage) : undefined;
		return base;
	}
	const m = message as ToolResultMessage;
	base.toolName = m.toolName;
	base.toolCallId = m.toolCallId;
	base.isError = m.isError;
	base.text = textOfContent(m.content);
	base.details = jsonOf(m.details);
	return base;
}

/** Tee a committed session event into the debug trace (no-op when disabled). */
export function sessionDebugLog(event: AgentSessionEvent): void {
	if (!sessionDebugLogEnabled()) return;
	const file = sessionLogPath();
	switch (event.type) {
		case "agent_start":
			appendLine(file, JSON.stringify({ t: "agent_start", ts: Date.now() }));
			return;
		case "agent_end":
			appendLine(
				file,
				JSON.stringify({
					t: "agent_end",
					ts: Date.now(),
					isTerminal: "isTerminal" in event ? event.isTerminal : undefined,
					messageCount: event.messages.length,
				}),
			);
			return;
		case "message_start":
			appendLine(file, JSON.stringify({ t: "message_start", ...messageRecord(event.message) }));
			return;
		case "message_end":
			appendLine(file, JSON.stringify({ t: "message_end", ...messageRecord(event.message) }));
			return;
		case "turn_end":
			appendLine(
				file,
				JSON.stringify({
					t: "turn_end",
					ts: Date.now(),
					message: messageRecord(event.message),
					toolResults: event.toolResults.map(r => ({
						toolName: r.toolName,
						toolCallId: r.toolCallId,
						isError: r.isError,
						text: textOfContent(r.content),
					})),
				}),
			);
			return;
		case "tool_execution_start":
			appendLine(
				file,
				JSON.stringify({
					t: "tool_start",
					ts: Date.now(),
					toolName: event.toolName,
					callId: event.toolCallId,
					intent: event.intent,
					args: jsonOf(event.args),
				}),
			);
			return;
		case "tool_execution_end":
			appendLine(
				file,
				JSON.stringify({
					t: "tool_end",
					ts: Date.now(),
					toolName: event.toolName,
					callId: event.toolCallId,
					isError: event.isError === true,
					result: jsonOf(event.result),
				}),
			);
			return;
		case "notice":
			if (event.level !== "error") return;
			appendLine(
				file,
				JSON.stringify({
					t: "notice",
					level: event.level,
					message: event.message,
					source: event.source,
					ts: Date.now(),
				}),
			);
			return;
		case "auto_retry_start":
			appendLine(
				file,
				JSON.stringify({
					t: "auto_retry_start",
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					error: event.errorMessage,
					ts: Date.now(),
				}),
			);
			return;
		case "auto_retry_end":
			appendLine(
				file,
				JSON.stringify({
					t: "auto_retry_end",
					success: event.success,
					attempt: event.attempt,
					finalError: event.finalError,
					retryErrors: event.retryErrors,
					ts: Date.now(),
				}),
			);
			return;
		case "auto_compaction_start":
			appendLine(
				file,
				JSON.stringify({ t: "auto_compaction_start", reason: event.reason, action: event.action, ts: Date.now() }),
			);
			return;
		case "auto_compaction_end":
			appendLine(
				file,
				JSON.stringify({
					t: "auto_compaction_end",
					action: event.action,
					aborted: event.aborted,
					skipped: event.skipped,
					errorMessage: event.errorMessage,
					ts: Date.now(),
				}),
			);
			return;
		case "message_update":
		default:
			return;
	}
}
