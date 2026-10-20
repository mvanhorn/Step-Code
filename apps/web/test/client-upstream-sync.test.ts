import assert from "node:assert/strict";
import test from "node:test";
import { collectTurnFooters } from "../client/src/features/conversation/turn-footers.ts";
import { timelineFromEntries } from "../client/src/state/session.ts";
import type { SessionEntry, SessionRetry } from "../client/src/state/types.ts";

const retry: SessionRetry = {
	attempt: 1,
	maxAttempts: 3,
	delayMs: 4000,
	startedAt: 1000,
	errorMessage: "503 retry",
};

test("retry projection drops an abandoned attempt without duplicating the successful thinking, text or tools", () => {
	const entries: SessionEntry[] = [
		{ id: "user", type: "message", message: { role: "user", content: "Continue" } },
		{
			id: "failed",
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Abandoned thought" },
					{ type: "toolCall", id: "unused", name: "bash", arguments: { command: "never-ran" } },
				],
				stopReason: "error",
				errorMessage: retry.errorMessage,
			},
		},
		{
			id: "ok",
			type: "message",
			thinkingTimings: { "0": { startedAt: 2000, endedAt: 5000 } },
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Successful thought" },
					{ type: "text", text: "Dispatching" },
					{ type: "toolCall", id: "child", name: "subagent", arguments: { agent: "worker", task: "Inspect" } },
					{ type: "text", text: "Finished" },
				],
			},
		},
		{
			id: "result",
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "child",
				content: "done",
				details: { results: [{ agent: "worker", task: "Inspect", status: "completed", sessionId: "child-id" }] },
			},
		},
	];
	const items = timelineFromEntries(entries);
	assert.deepEqual(items.map((item) => item.kind), ["message", "retry", "thinking", "message", "tool", "message"]);
	const thought = items[2];
	assert.equal(thought?.kind === "thinking" ? thought.content : undefined, "Successful thought");
	assert.deepEqual(thought?.kind === "thinking" ? thought.timing : undefined, { startedAt: 2000, endedAt: 5000 });
	const tool = items[4];
	assert.equal(tool?.kind === "tool" ? tool.subagentTasks?.[0]?.sessionId : undefined, "child-id");
	const footers = collectTurnFooters(items, "completed", false);
	assert.equal(footers.length, 1);
	assert.equal(footers[0].lastIndex, items.length - 1);
	assert.deepEqual(footers[0].messages.map((message) => message.content), ["Dispatching", "Finished"]);
});

test("an image-only prompt keeps its thumbnails and cannot expose actions while retrying", () => {
	const entries: SessionEntry[] = [
		{
			id: "image-user",
			type: "message",
			message: { role: "user", content: [{ type: "image", mimeType: "image/png", data: "AA==" }] },
		},
		{ id: "intro", type: "message", message: { role: "assistant", content: "Checking the image" } },
		{
			id: "failed",
			type: "message",
			message: { role: "assistant", content: [], stopReason: "error", errorMessage: retry.errorMessage },
		},
	];
	const items = timelineFromEntries(entries, retry);
	const first = items[0];
	assert.deepEqual(first?.kind === "message" ? first.images : undefined, ["data:image/png;base64,AA=="]);
	assert.equal(items.at(-1)?.kind, "retry");
	assert.deepEqual(collectTurnFooters(items, "running", false), []);
});

test("a final non-retried failure preserves its saved thought followed by a single error card", () => {
	const items = timelineFromEntries([
		{
			id: "failed",
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "Observed before failure" }],
				stopReason: "error",
				errorMessage: "400 invalid",
			},
		},
	]);
	assert.deepEqual(items.map((item) => item.kind), ["thinking", "message"]);
	const error = items[1];
	assert.equal(error?.kind === "message" ? error.error : undefined, "400 invalid");
	assert.deepEqual(collectTurnFooters(items, "failed", false), []);
});
