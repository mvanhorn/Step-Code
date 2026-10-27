import { expect, test } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { MAX_LIVE_UPDATE_BYTES, toJsonEvent } from "../src/modes/json-event.ts";

/**
 * `tool_execution_update` is live progress, but json/rpc hosts write each event
 * as one JSONL line. The subagent orchestrator keeps its own live payload small;
 * this is the generic backstop for any other tool that re-sends accumulated
 * state, so one update can never become a multi-megabyte log line.
 *
 * The budget is on the *serialized* event: a control character or a lone
 * surrogate becomes a six-byte JSON escape, so counting raw characters would
 * under-count the bytes the host actually writes.
 */

function update(partialResult: unknown): AgentSessionEvent {
	return {
		type: "tool_execution_update",
		toolCallId: "call_1",
		toolName: "subagent",
		args: { agent: "general" },
		partialResult,
	};
}

function boundedEvent(partialResult: unknown): Extract<AgentSessionEvent, { type: "tool_execution_update" }> {
	return toJsonEvent(update(partialResult)) as Extract<AgentSessionEvent, { type: "tool_execution_update" }>;
}

function bytesOf(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function textOf(event: Extract<AgentSessionEvent, { type: "tool_execution_update" }>): string {
	const part = event.partialResult?.content?.[0];
	return part?.type === "text" ? part.text : "";
}

test("a live update under the budget passes through untouched", () => {
	const event = update({ content: [{ type: "text", text: "working" }], details: { results: [] } });
	expect(toJsonEvent(event)).toBe(event);
});

test("an oversized live update is bounded by serialized size, not raw characters", () => {
	const big = "x".repeat(4 * 1024 * 1024);
	const bounded = boundedEvent({
		content: [{ type: "text", text: big }],
		details: { results: [{ messages: [{ role: "user", content: big }] }] },
	});

	expect(bytesOf(bounded)).toBeLessThanOrEqual(MAX_LIVE_UPDATE_BYTES);
	// The tail is what a live view renders, and the marker explains the gap.
	expect(textOf(bounded).endsWith("[live output truncated]")).toBe(true);
	expect(textOf(bounded).length).toBeGreaterThan(0);
	// `details`/`args` are already on tool_execution_start and tool_execution_end.
	expect(bounded.partialResult.details).toBeUndefined();
	expect(bounded.args).toBeUndefined();
});

test.each([
	["control characters", "\u0001"],
	["quotes and backslashes", '"\\'],
	["multi-byte CJK", "\u4e2d"],
	["lone surrogate", "\ud800"],
])("an oversized update of %s still respects the byte budget", (_label, unit) => {
	const bounded = boundedEvent({ content: [{ type: "text", text: unit.repeat(300_000) }] });
	expect(bytesOf(bounded)).toBeLessThanOrEqual(MAX_LIVE_UPDATE_BYTES);
	expect(textOf(bounded)).toContain("[live output truncated]");
});

test("an update just above the budget keeps as much of the tail as fits", () => {
	const text = "z".repeat(Math.floor(MAX_LIVE_UPDATE_BYTES * 0.9));
	const bounded = boundedEvent({ content: [{ type: "text", text }] });
	expect(bytesOf(bounded)).toBeLessThanOrEqual(MAX_LIVE_UPDATE_BYTES);
	// Far more than the minimum: the halving loop stops at the first fit.
	expect(textOf(bounded).length).toBeGreaterThan(text.length / 2);
});

test("the envelope alone over budget still produces a minimal valid event", () => {
	const bounded = boundedEvent({ content: [{ type: "text", text: "x" }] });
	expect(bounded.type).toBe("tool_execution_update");
	expect(bounded.toolCallId).toBe("call_1");
});

test("the terminal tool_execution_end event is never bounded", () => {
	const big = "x".repeat(4 * 1024 * 1024);
	const event: AgentSessionEvent = {
		type: "tool_execution_end",
		toolCallId: "call_1",
		toolName: "subagent",
		result: { content: [{ type: "text", text: big }] },
		isError: false,
	};
	expect(toJsonEvent(event)).toBe(event);
});
