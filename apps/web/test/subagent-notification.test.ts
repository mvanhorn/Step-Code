import assert from "node:assert/strict";
import test from "node:test";
import { projectEntry } from "../src/runtime.ts";
import { projectSubagentNotification } from "../src/subagent-notification.ts";

test("notification projection permits lifecycle fields only", () => {
	const details = { agentId: "lane-1", event: "background_done", status: "completed", secret: "not projected", detail: "not projected" };
	assert.deepEqual(projectSubagentNotification("agent-notification", details), {
		agentId: "lane-1", event: "background_done", status: "completed",
	});
	const entry = projectEntry({ id: "n", parentId: null, type: "custom_message", timestamp: "2026-10-19", customType: "agent-notification", content: "", display: false, details });
	assert.deepEqual(entry.details, { agentId: "lane-1", event: "background_done", status: "completed" });
});

test("invalid notifications and unrelated custom entries expose no lifecycle payload", () => {
	for (const details of [null, [], {}, { agentId: "../other", event: "background_done", status: "completed" }, { agentId: "lane", event: "background_done", status: "running" }, { agentId: "lane", event: "toString", status: "completed" }]) {
		assert.equal(projectSubagentNotification("agent-notification", details), undefined);
	}
	assert.equal(projectSubagentNotification("other", { agentId: "lane", event: "background_done", status: "completed" }), undefined);
});
