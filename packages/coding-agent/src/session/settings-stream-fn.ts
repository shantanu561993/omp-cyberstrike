/**
 * Settings-aware stream wrapper shared by the main agent (sdk.ts) and the
 * advisor agent (AgentSession.#buildAdvisorRuntime).
 *
 * verbosity, stream watchdog budgets, per-provider in-flight caps, and the loop
 * guard out of `Settings`
 * per request, layering them onto whatever options the caller passed. Before
 * this helper existed, advisor turns called bare `streamSimple` while the main
 * turn went through an inline closure that read these settings — so an advisor on
 * OpenRouter never saw `providers.openrouterVariant`, breaking sticky routing
 * and OpenRouter response-cache hits across advisor calls.
 */
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type SimpleStreamOptions,
	streamSimple,
} from "@oh-my-pi/pi-ai";
import { isAnthropicFableOrMythosModel } from "@oh-my-pi/pi-catalog/identity";
import { ModelsConfigFile } from "../config/models-config";
import { type Settings, validateProviderMaxInFlightRequests } from "../config/settings";

type AssistantMessageEvent = AssistantMessageEventStream extends AsyncIterable<infer TEvent> ? TEvent : never;

function timeoutSecondsToMs(value: number): number | undefined {
	if (!Number.isFinite(value) || value < 0) return undefined;
	if (value === 0) return 0;
	return Math.max(1, Math.trunc(value * 1000));
}

/** True when the assistant message carries text or a tool call worth acting on. */
function hasActionableContent(message: AssistantMessage): boolean {
	return message.content.some(item => {
		if (item.type === "text") return item.text.trim().length > 0;
		if (item.type === "toolCall") return true;
		return false;
	});
}

/**
 * Wrap a provider call so a turn that comes back EMPTY (no text, no tool call)
 * is re-issued once with `tool_choice: "required"`. Some self-hosted
 * fine-tunes reason but never volunteer a call under the default `auto`
 * choice; the forced retry makes them act instead of stalling the loop. The
 * first attempt is buffered and only forwarded when usable, so the agent loop
 * always sees one coherent turn — a stalled attempt is discarded wholesale and
 * replaced by the retry, which streams live.
 */
export function retryEmptyTurnWithForcedToolChoice(
	callAuto: () => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
	callForced: () => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	void (async () => {
		const buffered: AssistantMessageEvent[] = [];
		try {
			for await (const event of await callAuto()) {
				if (event.type === "done") {
					if (hasActionableContent(event.message)) {
						for (const bufferedEvent of buffered) out.push(bufferedEvent);
						out.push(event);
					} else {
						// Empty turn: discard the buffer, re-issue once with a
						// forced tool choice and forward the retry as-is.
						for await (const retryEvent of await callForced()) out.push(retryEvent);
					}
					return;
				}
				if (event.type === "error") {
					for (const bufferedEvent of buffered) out.push(bufferedEvent);
					out.push(event);
					return;
				}
				buffered.push(event);
			}
		} catch (err) {
			out.fail(err);
		}
	})();
	return out;
}

/**
 * Build a {@link StreamFn} that reads provider routing/guard settings from
 * `settings` per call and forwards to `base` (defaults to `streamSimple`).
 *
 * Caller-supplied `streamOptions` always win — the helper only fills holes.
 */
export function createSettingsAwareStreamFn(settings: Settings, base: StreamFn = streamSimple): StreamFn {
	return (model, context, streamOptions) => {
		const openrouterRoutingPreset = settings.get("providers.openrouterVariant");
		const openrouterVariant =
			openrouterRoutingPreset && openrouterRoutingPreset !== "default" ? openrouterRoutingPreset : undefined;
		const antigravityEndpointMode = settings.get("providers.antigravityEndpoint");
		const textVerbosity =
			model.api === "openai-codex-responses"
				? settings.isConfigured("textVerbosity")
					? settings.get("textVerbosity")
					: undefined
				: model.api === "openai-responses"
					? settings.get("textVerbosity")
					: undefined;
		// "auto" leaves the option unset so provider defaults and the
		// PI_CACHE_RETENTION env override keep working; anything else is an
		// explicit per-request retention (long restores 1h Anthropic TTLs and
		// implicitly disables the short-entry keep-alive refresh loop).
		const cacheRetentionSetting = settings.get("providers.cacheRetention");
		const cacheRetention = cacheRetentionSetting === "auto" ? undefined : cacheRetentionSetting;
		const streamFirstEventTimeoutMs = timeoutSecondsToMs(settings.get("providers.streamFirstEventTimeoutSeconds"));
		const streamIdleTimeoutMs = timeoutSecondsToMs(settings.get("providers.streamIdleTimeoutSeconds"));
		// Server-side fallback (opt-in): when the user enables it AND the
		// resolved model is a Claude Fable/Mythos on Anthropic's messages
		// API, inject the `fallbacks: [{ model: "claude-opus-4-8" }]` chain.
		// The provider layer picks it up, sends the beta header, and honors
		// the response signals. Every other model / API is untouched.
		const serverSideFallbackEnabled =
			settings.get("providers.anthropic.serverSideFallback") &&
			model.api === "anthropic-messages" &&
			model.provider === "anthropic" &&
			isAnthropicFableOrMythosModel(model.id);
		const fallbacks =
			streamOptions?.fallbacks ?? (serverSideFallbackEnabled ? [{ model: "claude-opus-4-8" }] : undefined);
		const merged: SimpleStreamOptions = {
			...streamOptions,
			openrouterVariant: streamOptions?.openrouterVariant ?? openrouterVariant,
			antigravityEndpointMode: streamOptions?.antigravityEndpointMode ?? antigravityEndpointMode,
			textVerbosity: streamOptions?.textVerbosity ?? textVerbosity,
			cacheRetention: streamOptions?.cacheRetention ?? cacheRetention,
			streamFirstEventTimeoutMs: streamOptions?.streamFirstEventTimeoutMs ?? streamFirstEventTimeoutMs,
			streamIdleTimeoutMs: streamOptions?.streamIdleTimeoutMs ?? streamIdleTimeoutMs,
			maxRetryDelayMs: streamOptions?.maxRetryDelayMs ?? settings.get("retry.maxDelayMs"),
			maxInFlightRequests: validateProviderMaxInFlightRequests(
				streamOptions?.maxInFlightRequests ?? settings.get("providers.maxInFlightRequests"),
			),
			loopGuard: {
				enabled: settings.get("model.loopGuard.enabled"),
				checkAssistantContent: settings.get("model.loopGuard.checkAssistantContent"),
				...streamOptions?.loopGuard,
			},
			hideThinkingSummary: streamOptions?.hideThinkingSummary ?? settings.get("omitThinking"),
			...(fallbacks !== undefined ? { fallbacks } : {}),
		};
		const modelsConfig = ModelsConfigFile.tryLoad();
		const providerConfig = modelsConfig.status === "ok" ? modelsConfig.value?.providers?.[model.provider] : undefined;
		if (providerConfig?.forceToolChoiceOnEmpty !== true) {
			return base(model, context, merged);
		}
		// Per-provider `forceToolChoiceOnEmpty`: re-issue empty turns once with
		// a forced tool choice (see retryEmptyTurnWithForcedToolChoice).
		const call = (options: SimpleStreamOptions) => base(model, context, options);
		return retryEmptyTurnWithForcedToolChoice(
			() => call(merged),
			() => call({ ...merged, toolChoice: "required" }),
		);
	};
}
