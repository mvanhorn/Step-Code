import assert from "node:assert/strict";
import test from "node:test";
import { collectTurnFooters } from "../client/src/features/conversation/turn-footers.ts";
import { assistantBlocks } from "../client/src/state/assistant-content.ts";
import { liveMessageTimeline, timelineFromEntries } from "../client/src/state/session.ts";
import type { SessionEntry, TimelineItem } from "../client/src/state/types.ts";

function entry(id: string, role: string, content: unknown): SessionEntry {
	return { id, type: "message", message: { role, content } } as SessionEntry;
}

const thought = { type: "thinking", thinking: "Check **both** files.", thinkingSignature: "opaque-not-for-display" };
const call = { type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.md" } };

test("saved thinking, prose and tools retain original block order", () => {
	const entries = [
		entry("u", "user", "Check."),
		{ ...entry("a", "assistant", [
			thought,
			{ type: "text", text: "First prose." },
			call,
			{ type: "thinking", thinking: "Reconsider." },
			{ type: "text", text: "Final prose." },
		]), usage: { input: 10, output: 5 } },
		{ ...entry("r", "toolResult", "file"), message: { role: "toolResult", toolCallId: call.id, content: "file" } },
	];
	const rows = timelineFromEntries(entries);
	assert.deepEqual(rows.map((row) => row.kind), ["message", "thinking", "message", "tool", "thinking", "message"]);
	assert.equal(rows[1]?.kind === "thinking" && rows[1].running, false);
	assert.equal(JSON.stringify(rows).includes(thought.thinkingSignature), false);
	const messages = rows.filter((row) => row.kind === "message" && row.role === "assistant");
	assert.deepEqual(messages.map((row) => row.content), ["First prose.", "Final prose."]);
	assert.deepEqual(messages.map((row) => row.usage), [{ input: 10, output: 5 }, undefined]);
	assert.equal(collectTurnFooters(rows, "completed", false)[0]?.lastIndex, 5);
	assert.deepEqual(collectTurnFooters(rows, "completed", false)[0]?.messages, messages);
	assert.deepEqual(timelineFromEntries(entries), rows);
});

test("redacted, empty, malformed and signature-only blocks are not displayed", () => {
	const content = [
		null,
		{ type: "thinking", thinking: "hidden", redacted: true, thinkingSignature: "encrypted" },
		{ type: "thinking", thinkingSignature: "encrypted" },
		{ type: "thinking", thinking: 12 },
		{ type: "thinking", thinking: "" },
		{ type: "thinking", thinking: "visible" },
		{ type: "text", text: "" },
		{ type: "toolCall", id: null, name: "read" },
	];
	assert.deepEqual(assistantBlocks(content), [{ type: "thinking", thinking: "visible", index: 5 }]);
	assert.equal(timelineFromEntries([entry("a", "assistant", content)]).length, 1);
});

test("old plain-text history gets no fake thinking or changed first message id", () => {
	const [row] = timelineFromEntries([entry("a", "assistant", "Plain reply.")]);
	assert.equal(row?.itemId, "message-a");
	assert.equal(row?.kind, "message");
	assert.equal(timelineFromEntries([entry("a", "assistant", [call])])[0]?.kind, "tool");
});

test("live thinking keeps a stable row identity while its content grows", () => {
	const first = liveMessageTimeline([], [thought], 0);
	const next = liveMessageTimeline(first, [{ ...thought, thinking: `${thought.thinking} More.` }], 0);
	assert.equal(next.length, 1);
	assert.equal(next[0]?.itemId, first[0]?.itemId);
	assert.equal(next[0]?.kind === "thinking" && next[0].running, true);
	assert.equal(JSON.stringify(next).includes(thought.thinkingSignature), false);
	assert.deepEqual(collectTurnFooters(next, "running", false), []);
	assert.deepEqual(collectTurnFooters(next, "completed", false), []);
});

test("prose, tool arguments and thinking_end stop the previous thinking state", () => {
	const active = liveMessageTimeline([], [thought], 0);
	for (const content of [[thought], [thought, { type: "text", text: "Reply." }], [thought, call]]) {
		const rows = liveMessageTimeline(active, content);
		assert.equal(rows[0]?.kind === "thinking" && rows[0].running, false);
		assert.equal(rows.filter((row) => row.kind === "thinking").length, 1);
	}
	const toolRows = liveMessageTimeline(active, [thought, call]);
	assert.equal(toolRows[1]?.kind === "tool" && toolRows[1].state, "pending");
});

test("a later thought runs independently after earlier prose and tools", () => {
	const rows = liveMessageTimeline([], [
		thought,
		{ type: "text", text: "One." },
		call,
		{ type: "thinking", thinking: "Second thought." },
	], 3);
	assert.deepEqual(rows.map((row) => row.kind), ["thinking", "message", "tool", "thinking"]);
	assert.deepEqual(rows.filter((row) => row.kind === "thinking").map((row) => row.running), [false, true]);
});

test("streamed tools retain authoritative completed and failed results", () => {
	for (const state of ["completed", "failed"] as const) {
		const rows: TimelineItem[] = [{ kind: "tool", itemId: `tool-${call.id}`, toolName: "read", state, inputSummary: "", outputSummary: "Actual result." }];
		const next = liveMessageTimeline(rows, [thought, call]);
		assert.equal(next[1], rows[0]);
		assert.equal(next.filter((row) => row.kind === "tool").length, 1);
	}
});

test("thinking-only failures retain the thought before the error, never a fake thinking placeholder", () => {
	const failure: SessionEntry = {
		...entry("a", "assistant", [thought]),
		message: { role: "assistant", content: [thought], stopReason: "error", errorMessage: "Failed" },
	};
	const rows = timelineFromEntries([failure]);
	assert.deepEqual(rows.map((row) => row.kind), ["thinking", "message"]);
	assert.equal(rows[1]?.kind === "message" && rows[1].error, "Failed");
});

test("streaming text split around thoughts keeps all prose and never exposes a premature footer", () => {
	const rows = liveMessageTimeline([], [
		{ type: "text", text: "Before." },
		thought,
		{ type: "text", text: "After." },
	]);
	assert.deepEqual(rows.map((row) => row.itemId), ["message-live", "message-live-thinking-1", "message-live-text-2"]);
	assert.deepEqual(collectTurnFooters(rows, "completed", false), []);
});
