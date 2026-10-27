import { expect, test } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { MAX_LIVE_UPDATE_BYTES, toJsonEvent } from "../src/modes/json-event.ts";

/**
 * `tool_execution_update` is live progress, but json/rpc hosts write each event
 * as one JSONL line. The subagent orchestrator keeps its own live payload small;
 * this is the generic backstop for any other tool that re-sends accumulated
 * state, so one update can never become a multi-megabyte log line.
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

test("a live update under the budget passes through untouched", () => {
	const event = update({ content: [{ type: "text", text: "working" }], details: { results: [] } });
	expect(toJsonEvent(event)).toBe(event);
});

test("an oversized live update is bounded while the terminal result is not", () => {
	const big = "x".repeat(4 * 1024 * 1024);
	const bounded = toJsonEvent(
		update({
			content: [{ type: "text", text: big }],
			details: { results: [{ messages: [{ role: "user", content: big }] }] },
		}),
	) as Extract<AgentSessionEvent, { type: "tool_execution_update" }>;

	expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThan(MAX_LIVE_UPDATE_BYTES / 2);
	// The tail is what a live view renders, and the marker explains the gap.
	const text = bounded.partialResult.content[0]?.type === "text" ? bounded.partialResult.content[0].text : "";
	expect(text.endsWith("[live output truncated]")).toBe(true);
	// `details`/`args` are already on tool_execution_start and tool_execution_end.
	expect(bounded.partialResult.details).toBeUndefined();
	expect(bounded.args).toBeUndefined();
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
