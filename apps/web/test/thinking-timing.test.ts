import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type AgentSessionEvent, createStepSessionManager, readSessionBranch } from "@step-harness/coding-agent";
import type { AssistantMessage, AssistantMessageEvent } from "@step-harness/providers";
import { projectEntries } from "../src/runtime.ts";
import { readThinkingObservation, savedThinkingTimings, THINKING_TIMING_TYPE, ThinkingClock } from "../src/thinking-timing.ts";

const message: AssistantMessage = {
	role: "assistant",
	content: [{ type: "thinking", thinking: "Check." }, { type: "text", text: "Answer." }],
	api: "faux",
	provider: "faux",
	model: "faux",
	usage: {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 100,
};

function update(delta: AssistantMessageEvent, current = message): AgentSessionEvent {
	return { type: "message_update", message: current, assistantMessageEvent: delta };
}

test("thinking duration starts at its stream event, not message creation, and freezes before prose", () => {
	const clock = new ThinkingClock();
	clock.observe({ type: "message_start", message }, 1000);
	assert.equal(clock.completed(), undefined);
	assert.deepEqual(clock.observe(update({ type: "thinking_start", contentIndex: 0, partial: message }), 3000), {
		0: { startedAt: 3000 },
	});
	clock.observe(update({ type: "thinking_delta", contentIndex: 0, delta: "Check", partial: message }), 5000);
	assert.deepEqual(clock.observe(update({ type: "text_start", contentIndex: 1, partial: message }), 10000), {
		0: { startedAt: 3000, endedAt: 10000 },
	});
	clock.observe({ type: "message_end", message }, 20000);
	assert.deepEqual(clock.completed()?.thinkingTimings, { 0: { startedAt: 3000, endedAt: 10000 } });
	assert.equal(clock.completed(), undefined);
});

test("later thinking has its own clock and tool arguments stop it without adding tool time", () => {
	const clock = new ThinkingClock();
	clock.observe(update({ type: "thinking_start", contentIndex: 0, partial: message }), 1000);
	clock.observe(update({ type: "thinking_end", contentIndex: 0, content: "Check", partial: message }), 4000);
	clock.observe(update({ type: "thinking_delta", contentIndex: 2, delta: "Again", partial: message }), 9000);
	clock.observe(update({ type: "toolcall_start", contentIndex: 3, partial: message }), 16000);
	clock.observe({ type: "agent_settled" }, 50000);
	assert.deepEqual(clock.completed()?.thinkingTimings, {
		0: { startedAt: 1000, endedAt: 4000 },
		2: { startedAt: 9000, endedAt: 16000 },
	});
});

test("interruption and failure close observations; unobserved history receives no fabricated interval", () => {
	for (const stop of [
		{ type: "message_end", message: { ...message, stopReason: "aborted" } },
		{ type: "agent_end", messages: [message], willRetry: false },
		{ type: "agent_settled" },
		{ type: "tool_execution_start", toolCallId: "t", toolName: "read", args: {} },
	] satisfies AgentSessionEvent[]) {
		const clock = new ThinkingClock();
		clock.observe(update({ type: "thinking_delta", contentIndex: 0, delta: "Check", partial: message }), 1000);
		clock.observe(stop, 2500);
		assert.deepEqual(clock.completed()?.thinkingTimings, { 0: { startedAt: 1000, endedAt: 2500 } });
	}
	const clock = new ThinkingClock();
	clock.observe({ type: "message_end", message }, 5000);
	assert.equal(clock.completed(), undefined);
});

test("observers and successive messages never share intervals", () => {
	const first = new ThinkingClock();
	const second = new ThinkingClock();
	first.observe(update({ type: "thinking_start", contentIndex: 0, partial: message }), 1000);
	second.observe(update({ type: "thinking_start", contentIndex: 0, partial: message }), 3000);
	first.observe({ type: "message_end", message }, 5000);
	assert.deepEqual(first.completed()?.thinkingTimings, { 0: { startedAt: 1000, endedAt: 5000 } });
	assert.equal(second.completed(), undefined);
	first.observe(update({ type: "thinking_start", contentIndex: 0, partial: message }, { ...message, timestamp: 200 }), 8000);
	first.observe({ type: "agent_settled" }, 11000);
	assert.deepEqual(first.completed()?.thinkingTimings, { 0: { startedAt: 8000, endedAt: 11000 } });
});

test("metadata rejects unfinished, malformed, non-finite and reversed intervals", () => {
	for (const timing of [
		{ startedAt: 1 }, { startedAt: 5, endedAt: 1 }, { startedAt: NaN, endedAt: 10 },
		{ startedAt: 1, endedAt: Infinity }, { startedAt: "1", endedAt: 5 },
	]) {
		assert.equal(readThinkingObservation({ version: 1, messageTimestamp: 100, thinkingTimings: { 0: timing } }), undefined);
	}
	assert.equal(readThinkingObservation({ version: 2, messageTimestamp: 100, thinkingTimings: {} }), undefined);
	assert.equal(readThinkingObservation({ version: 1, messageTimestamp: 100, thinkingTimings: { "-1": { startedAt: 1, endedAt: 5 } } }), undefined);
});

test("session-manager metadata survives reopen without changing provider messages or model context", async () => {
	const agentDir = await realpath(await mkdtemp(join(tmpdir(), "stepcode-thinking-time-")));
	try {
		const manager = createStepSessionManager("/fixture", { agentDir });
		manager.appendMessage({ role: "user", content: "Check.", timestamp: 1 });
		const observation = { version: 1, messageTimestamp: message.timestamp, thinkingTimings: { 0: { startedAt: 1000, endedAt: 8000 } } };
		// AgentSession notifies message_end listeners before it appends the canonical message.
		manager.appendCustomEntry(THINKING_TIMING_TYPE, observation);
		manager.appendMessage(message);
		const path = manager.getSessionFile();
		assert.ok(path);
		const reopened = await readSessionBranch(path);
		assert.ok(reopened);
		assert.deepEqual(savedThinkingTimings(reopened.branch).get(message.timestamp), observation.thinkingTimings);
		const assistant = projectEntries(reopened.branch).find(entry => (entry.message as { role?: string } | undefined)?.role === "assistant");
		assert.deepEqual(assistant?.thinkingTimings, observation.thinkingTimings);
		assert.deepEqual(assistant?.message, message);
		assert.equal(JSON.stringify(manager.buildSessionContext()).includes(THINKING_TIMING_TYPE), false);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});
