import assert from "node:assert/strict";
import test from "node:test";
import { RetryTracker } from "../src/retry-state.ts";

const start = {
	type: "auto_retry_start",
	attempt: 2,
	maxAttempts: 3,
	delayMs: 4000,
	errorMessage: "504 Upstream request timed out",
} as const;

test("an active kernel retry is kept for the snapshot until it ends", () => {
	const tracker = new RetryTracker(() => 1_000);
	assert.equal(tracker.view(), undefined);
	assert.equal(tracker.apply(start), true);
	assert.deepEqual(tracker.view(), {
		attempt: 2,
		maxAttempts: 3,
		delayMs: 4000,
		startedAt: 1_000,
		errorMessage: "504 Upstream request timed out",
	});
	// The retried request streams normally; the retry stays visible until it resolves.
	assert.equal(tracker.apply({ type: "agent_start" }), false);
	assert.ok(tracker.view());
	assert.equal(tracker.apply({ type: "auto_retry_end", success: true, attempt: 2 }), true);
	assert.equal(tracker.view(), undefined);
});

test("a settled run clears a retry whose end event never came", () => {
	const tracker = new RetryTracker(() => 0);
	tracker.apply({ ...start, reason: "rate_limit" });
	assert.equal(tracker.view()?.reason, "rate_limit");
	assert.equal(tracker.apply({ type: "agent_settled" }), true);
	assert.equal(tracker.view(), undefined);
	assert.equal(tracker.apply({ type: "agent_settled" }), false);
});
