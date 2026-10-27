import type { Usage } from "@step-harness/providers";
import type { AgentSessionEvent } from "../core/agent-session.ts";

type WithoutPartial<T> = T extends { partial: unknown } ? Omit<T, "partial"> : T;

type ToJsonAssistantMessageEvent<T> = T extends { type: "toolcall_start"; partial: unknown }
	? WithoutPartial<T> & { id: string; toolName: string }
	: WithoutPartial<T>;

type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;
type JsonMessageUpdateEvent = {
	type: "message_update";
	usage: Usage;
	assistantMessageEvent: ToJsonAssistantMessageEvent<MessageUpdateEvent["assistantMessageEvent"]>;
};

/** Session event shape emitted by the JSON and RPC stdout protocols. */
export type JsonAgentSessionEvent = Exclude<AgentSessionEvent, { type: "message_update" }> | JsonMessageUpdateEvent;

function toJsonAssistantMessageEvent(
	event: MessageUpdateEvent["assistantMessageEvent"],
): JsonMessageUpdateEvent["assistantMessageEvent"] {
	if (event.type === "toolcall_start") {
		const toolCall = event.partial.content[event.contentIndex];
		if (toolCall?.type !== "toolCall") {
			throw new Error(`toolcall_start content at index ${event.contentIndex} is not a tool call`);
		}
		const { partial: _partial, ...deltaEvent } = event;
		return { ...deltaEvent, id: toolCall.id, toolName: toolCall.name };
	}

	if (!("partial" in event)) {
		return event;
	}

	const { partial: _partial, ...deltaEvent } = event;
	return deltaEvent;
}

/**
 * Remove cumulative assistant snapshots from streaming wire events.
 * `message_start` provides the initial message, deltas build it, and
 * `message_end` provides the final authoritative message. Cumulative usage,
 * tool-call ids, and tool names remain available because their size is constant.
 *
 * `tool_execution_update` gets the same treatment: it is live progress, but
 * `json`/`rpc` hosts write every event as one JSONL line, so an unbounded
 * `partialResult` turns progress into multi-megabyte log lines. The terminal
 * `tool_execution_end` still carries the full result.
 */
export function toJsonEvent(event: MessageUpdateEvent): JsonMessageUpdateEvent;
export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent;
export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent {
	if (event.type === "tool_execution_update") {
		return boundLiveUpdate(event);
	}
	if (event.type !== "message_update") {
		return event;
	}
	if (event.message.role !== "assistant") {
		throw new Error("message_update message is not an assistant message");
	}

	return {
		type: "message_update",
		usage: event.message.usage,
		assistantMessageEvent: toJsonAssistantMessageEvent(event.assistantMessageEvent),
	};
}

/**
 * Byte ceiling for one live tool update on the wire.
 *
 * Chosen well above what a streaming tool legitimately sends per update (the
 * bash tool's rolling snapshot is 50 KiB and already throttled to 100ms) so this
 * only ever fires for a producer that re-sends accumulated state. It is a
 * backstop, not the primary bound: the subagent orchestrator keeps its own live
 * projection far below this.
 */
export const MAX_LIVE_UPDATE_BYTES = 256 * 1024;

/** Ceiling for a single identifier inside a bounded live update. */
const MAX_LIVE_IDENTIFIER_CHARS = 512;

const TRUNCATED_MARKER = "[live output truncated]";

type ToolExecutionUpdateEvent = Extract<AgentSessionEvent, { type: "tool_execution_update" }>;

function isTextPart(value: unknown): value is { type: "text"; text: string } {
	if (!value || typeof value !== "object") return false;
	const part = value as { type?: unknown; text?: string };
	return part.type === "text" && typeof part.text === "string";
}

function serializedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Keep a live update under the wire budget.
 *
 * The budget applies to the *serialized* event, envelope included, because that
 * is what the host writes. Measuring the raw text instead would under-count:
 * a control character or a lone surrogate becomes a six-byte JSON escape, so a
 * 64 KiB string can serialize to 384 KiB. The tail is retained because that is
 * what a live view renders; `details` and `args` are dropped because they are
 * already on the matching `tool_execution_start`/`tool_execution_end` events.
 *
 * A pathological `toolCallId`/`toolName` is clipped too: without that, the
 * envelope alone could exceed the budget and the function would have no valid
 * output to return.
 */
function boundLiveUpdate(event: ToolExecutionUpdateEvent): JsonAgentSessionEvent {
	if (serializedBytes(event) <= MAX_LIVE_UPDATE_BYTES) return event;
	const content: unknown[] = Array.isArray(event.partialResult?.content) ? event.partialResult.content : [];
	const text = content
		.filter(isTextPart)
		.map((part) => part.text)
		.join("\n");

	const candidate = (tail: string): JsonAgentSessionEvent => ({
		type: "tool_execution_update",
		// Ids come from the model or an extension. A 300 KB one is malformed, and
		// clipping it beats writing an unbounded line; correlation already failed.
		toolCallId: clip(event.toolCallId, MAX_LIVE_IDENTIFIER_CHARS),
		toolName: clip(event.toolName, MAX_LIVE_IDENTIFIER_CHARS),
		args: undefined,
		partialResult: {
			content: [
				{
					type: "text",
					text: tail.length > 0 ? `${tail}\n${TRUNCATED_MARKER}` : TRUNCATED_MARKER,
				},
			],
			details: undefined,
		},
	});

	// Halve the retained tail until the whole serialized event fits. Each round
	// strictly shrinks the string, so the loop terminates; `candidate("")` is the
	// floor and always fits once the envelope is clipped.
	let kept = text;
	let bounded = candidate(kept);
	while (kept.length > 0 && serializedBytes(bounded) > MAX_LIVE_UPDATE_BYTES) {
		kept = kept.length <= 1 ? "" : kept.slice(-Math.floor(kept.length / 2));
		bounded = candidate(kept);
	}
	return bounded;
}

function clip(value: string, max: number): string {
	if (value.length <= max) return value;
	const half = Math.max(1, Math.floor((max - 1) / 2));
	return `${value.slice(0, half)}\u2026${value.slice(-half)}`;
}
