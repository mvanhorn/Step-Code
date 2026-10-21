import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@step-harness/coding-agent";
import { projectInspectorTasks } from "../src/inspector.ts";

function snapshot(data: unknown): SessionEntry {
	return { type: "custom", id: "tasks", parentId: null, timestamp: "2026-10-19T00:00:00Z", customType: "step-tasks", data };
}

test("inspector projects only the active branch's latest task snapshot", () => {
	const projected = projectInspectorTasks([
		snapshot({ tasks: [{ id: "old", subject: "Old", status: "completed" }] }),
		snapshot({ activePlan: { id: "p1", title: "Plan", private: "hidden" }, tasks: [
			{ id: "1", subject: "Pending", description: "Detail", status: "pending", metadata: { token: "secret" } },
			{ id: "2", subject: "Running", status: "in_progress" },
			{ id: "3", subject: "Done", status: "completed" },
			{ id: "4", subject: "Deleted", status: "deleted" },
		] }),
	]);
	assert.deepEqual(projected, { plan: { id: "p1", title: "Plan" }, tasks: [
		{ id: "1", subject: "Pending", description: "Detail", status: "pending" },
		{ id: "2", subject: "Running", description: "", status: "in_progress" },
		{ id: "3", subject: "Done", description: "", status: "completed" },
	] });
});

test("missing, malformed, deleted and duplicate tasks never become invented task states", () => {
	assert.deepEqual(projectInspectorTasks([]), { tasks: [] });
	assert.deepEqual(projectInspectorTasks([snapshot(null)]), { tasks: [] });
	assert.deepEqual(projectInspectorTasks([snapshot({ tasks: [null, {}, { id: "x", subject: "Wrong", status: "failed" }] })]), { tasks: [] });
	assert.equal(projectInspectorTasks([snapshot({ tasks: [
		{ id: "x", subject: "One", status: "pending" },
		{ id: "x", subject: "Duplicate", status: "completed" },
	] })]).tasks.length, 1);
	assert.deepEqual(projectInspectorTasks([snapshot({ tasks: [{ id: "x", subject: "Old", status: "completed" }] }), snapshot({ tasks: [] })]), { tasks: [] });
});
