import { describe, expect, it } from "bun:test";
import type { AssistantMessage, AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { retryEmptyTurnWithForcedToolChoice } from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";

/** Build a stub stream that emits one `done` event carrying the given content. */
function streamWithContent(content: AssistantMessage["content"]): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
	stream.push({ type: "done", reason: "stop", message });
	return stream;
}

async function collect(stream: AssistantMessageEventStream): Promise<{ done?: AssistantMessage; errored?: boolean }> {
	let done: AssistantMessage | undefined;
	let errored = false;
	for await (const event of stream) {
		if (event.type === "done") done = event.message;
		if (event.type === "error") errored = true;
	}
	return { done, errored };
}

describe("retryEmptyTurnWithForcedToolChoice", () => {
	it("re-issues an empty turn once with the forced call and delivers the retry result", async () => {
		let autoCalls = 0;
		let forcedCalls = 0;
		const auto = () => {
			autoCalls++;
			return streamWithContent([{ type: "thinking", thinking: "I should call the tool", thinkingSignature: "x" }]);
		};
		const forced = () => {
			forcedCalls++;
			return streamWithContent([
				{ type: "thinking", thinking: "done", thinkingSignature: "x" },
				{ type: "toolCall", id: "call_1", name: "get_weather", arguments: { city: "Paris" } },
			]);
		};
		const result = await collect(retryEmptyTurnWithForcedToolChoice(auto, forced));
		expect(autoCalls).toBe(1);
		expect(forcedCalls).toBe(1);
		expect(result.done?.content.some(block => block.type === "toolCall")).toBe(true);
	});

	it("forwards a usable turn untouched without calling the forced path", async () => {
		let forcedCalls = 0;
		const auto = () => streamWithContent([{ type: "text", text: "Paris: sunny, 22C" }]);
		const forced = () => {
			forcedCalls++;
			return streamWithContent([
				{ type: "toolCall", id: "call_1", name: "get_weather", arguments: { city: "Paris" } },
			]);
		};
		const result = await collect(retryEmptyTurnWithForcedToolChoice(auto, forced));
		expect(forcedCalls).toBe(0);
		expect(result.done?.content.some(block => block.type === "text")).toBe(true);
	});

	it("forwards the second empty result as-is after the forced retry also stalls", async () => {
		const auto = () => streamWithContent([{ type: "thinking", thinking: "stall", thinkingSignature: "x" }]);
		const forced = () => streamWithContent([]);
		const result = await collect(retryEmptyTurnWithForcedToolChoice(auto, forced));
		expect(result.done?.content).toHaveLength(0);
	});
});
