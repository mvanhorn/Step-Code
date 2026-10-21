import assert from "node:assert/strict";
import test from "node:test";
import { childAgents, timelineFromEntries } from "../client/src/state/session.ts";
import type { SessionEntry } from "../client/src/state/types.ts";

function message(id: string, value: Record<string, unknown>): SessionEntry {
	return { type: "message", id, timestamp: "2026-10-17T00:00:00.000Z", message: value } as SessionEntry;
}

test("a subagent call links each child that recorded its session id", () => {
	const items = timelineFromEntries([
		message("a", { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "subagent", arguments: {} }] }),
		message("r", {
			role: "toolResult",
			toolCallId: "c1",
			details: {
				mode: "parallel",
				results: [
					{ agent: "explore", task: "find the parser", sessionId: "subagent-1" },
					// Recorded before results carried session ids: nothing to link.
					{ agent: "explore", task: "older run" },
				],
			},
		}),
	]);
	const tool = items.find((item) => item.kind === "tool");
	assert.deepEqual(tool?.kind === "tool" ? tool.children : undefined, [
		{ sessionId: "subagent-1", label: "explore · find the parser" },
	]);
});

test("a workflow call links its run, live progress included", () => {
	assert.deepEqual(childAgents("workflow", { schemaVersion: 1, runId: "wf_1", status: "running" }), {
		workflowRun: "wf_1",
	});
	// A failed call before the run started has no structured details.
	assert.deepEqual(childAgents("workflow", {}), {});
	// Only the workflow tool's details name a run.
	assert.deepEqual(childAgents("bash", { schemaVersion: 1, runId: "wf_1" }), {});
});
