import assert from "node:assert/strict";
import test from "node:test";
import { liveMessageTimeline, timelineFromEntries } from "../client/src/state/session.ts";
import { readThinkingTimings, thinkingElapsed } from "../client/src/state/thinking-timing.ts";

test("DFSC duration format uses elapsed seconds and freezes the completed endpoint", () => {
	assert.equal(thinkingElapsed({ startedAt: 1000 }, 8900), "7s");
	assert.equal(thinkingElapsed({ startedAt: 1000, endedAt: 17000 }, 900000), "16s");
	assert.equal(thinkingElapsed({ startedAt: 0, endedAt: 61000 }, 0), "1m1s");
	assert.equal(thinkingElapsed({ startedAt: 0, endedAt: 3661000 }, 0), "1h1m1s");
	assert.equal(thinkingElapsed({ startedAt: 1000 }, 0), "0s");
});

test("wire timings are validated and only complete timings enter saved history", () => {
	assert.deepEqual(readThinkingTimings({ 0: { startedAt: 1000 } }), { 0: { startedAt: 1000 } });
	assert.equal(readThinkingTimings({ 0: { startedAt: 1000 } }, true), undefined);
	for (const value of [[], null, { 0: { startedAt: 5, endedAt: 1 } }, { 0: { startedAt: NaN } }, { bad: { startedAt: 1 } }])
		assert.equal(readThinkingTimings(value), undefined);
});

test("saved and live thinking rows use the matching original block index, not neighboring durations", () => {
	const content = [
		{ type: "thinking", thinking: "First." },
		{ type: "text", text: "Prose." },
		{ type: "thinking", thinking: "Second." },
	];
	const timings = { 0: { startedAt: 1000, endedAt: 8000 }, 2: { startedAt: 20000, endedAt: 36000 } };
	const rows = timelineFromEntries([{ id: "a", type: "message", message: { role: "assistant", content }, thinkingTimings: timings }]);
	assert.deepEqual(rows.filter(row => row.kind === "thinking").map(row => row.timing), [timings[0], timings[2]]);
	assert.equal(timelineFromEntries([{ id: "old", type: "message", message: { role: "assistant", content } }]).some(row => row.kind === "thinking" && row.timing), false);
	const live = liveMessageTimeline([], content, 2, timings);
	assert.deepEqual(live.filter(row => row.kind === "thinking").map(row => row.timing), [timings[0], timings[2]]);
});
