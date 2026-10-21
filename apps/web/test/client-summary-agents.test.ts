import assert from "node:assert/strict";
import { test } from "node:test";
import { summaryAgentRecords } from "../client/src/features/inspector/model.ts";
import type { SubagentStatus, ToolTimelineItem } from "../client/src/state/types.ts";

const tool: ToolTimelineItem = {
	kind: "tool", itemId: "dispatch", toolName: "subagent", state: "completed", inputSummary: "Inspect", outputSummary: "Returned",
};

test("summary preserves per-dispatch task identities, statuses and detail selections", () => {
	const statuses: SubagentStatus[] = ["queued", "running", "completed", "failed", "aborted", "skipped", "unknown"];
	const item: ToolTimelineItem = {
		...tool,
		subagentTasks: statuses.map((status) => ({ agent: "explore", task: `Inspect ${status}`, status })),
	};
	const rows = summaryAgentRecords([item]);
	assert.equal(rows.length, statuses.length);
	assert.equal(new Set(rows.map((row) => row.key)).size, statuses.length);
	assert.deepEqual(rows.map((row) => row.status), statuses);
	assert.deepEqual(rows[3].target, { kind: "task", toolItemId: "dispatch", taskIndex: 3 });
	assert.equal(rows[3].task, "Inspect failed");
	assert.equal(item.subagentTasks?.[3].status, "failed");
});

test("structured records take precedence over child links so one dispatch is not counted twice", () => {
	const rows = summaryAgentRecords([{
		...tool,
		subagentTasks: [{ agent: "review", task: "Review", status: "completed", sessionId: "child" }],
		children: [{ sessionId: "child", label: "review" }],
		workflowRun: "run",
	}]);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].target.kind, "task");
});

test("legacy child and workflow records retain navigation without inventing lifecycle status", () => {
	const rows = summaryAgentRecords([
		{ ...tool, children: [{ sessionId: "child", label: "review" }] },
		{ ...tool, itemId: "workflow", toolName: "workflow", workflowRun: "run" },
		{ ...tool, itemId: "legacy-send", toolName: "agent_send", state: "failed" },
	]);
	assert.deepEqual(rows.map((row) => row.status), ["unknown", "unknown", "unknown"]);
	assert.deepEqual(rows[0].target, { kind: "child", sessionId: "child" });
	assert.deepEqual(rows[1].target, { kind: "workflow", runId: "run" });
	assert.deepEqual(rows[2].target, { kind: "task", toolItemId: "legacy-send", taskIndex: 0 });
});

test("ordinary tools and model prose do not create agent records", () => {
	assert.deepEqual(summaryAgentRecords([
		{ ...tool, toolName: "read", inputSummary: "subagent finished" },
		{ kind: "message", itemId: "assistant", role: "assistant", content: "Agent completed" },
	]), []);
	assert.deepEqual(summaryAgentRecords([]), []);
});

test("new structured notifications already projected in the timeline update the same record", () => {
	const before = summaryAgentRecords([{ ...tool, subagentTasks: [{ agent: "review", task: "Review", status: "running" }] }]);
	const after = summaryAgentRecords([{ ...tool, subagentTasks: [{ agent: "review", task: "Review", status: "failed" }] }]);
	assert.equal(before[0].key, after[0].key);
	assert.equal(before[0].status, "running");
	assert.equal(after[0].status, "failed");
});
