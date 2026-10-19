import assert from "node:assert/strict";
import test from "node:test";
import { timelineFromEntries } from "../client/src/state/session.ts";
import type { SessionEntry, SessionRetry } from "../client/src/state/types.ts";

function message(id: string, value: Record<string, unknown>): SessionEntry {
	return { type: "message", id, timestamp: "2026-10-19T00:00:00.000Z", message: value } as SessionEntry;
}

const user = (id: string) => message(id, { role: "user", content: "继续" });
const failed = (id: string, error: string) =>
	message(id, { role: "assistant", content: [], stopReason: "error", errorMessage: error });
const reply = (id: string) => message(id, { role: "assistant", content: [{ type: "text", text: "done" }] });

test("failures the kernel retried fold into one row; the reply follows", () => {
	const items = timelineFromEntries([user("u"), failed("e1", "504 a"), failed("e2", "504 b"), reply("ok")]);
	assert.deepEqual(
		items.map((item) => item.kind),
		["message", "retry", "message"],
	);
	assert.deepEqual(items[1], { itemId: "retry-e1", kind: "retry", errors: ["504 a", "504 b"] });
});

test("the failure a retry series gave up on stays an error card", () => {
	const items = timelineFromEntries([user("u"), failed("e1", "504 a"), failed("e2", "504 b")]);
	assert.equal(items[1]?.kind, "retry");
	const last = items.at(-1);
	assert.equal(last?.kind === "message" ? last.error : undefined, "504 b");
	// An auto-resume prompt between two failures is a new turn, not a kernel retry.
	const resumed = timelineFromEntries([failed("e1", "400 a"), user("resume"), failed("e2", "400 b")]);
	assert.deepEqual(
		resumed.map((item) => (item.kind === "message" ? (item.error ?? item.role) : item.kind)),
		["400 a", "user", "400 b"],
	);
});

test("a retry under way marks the trailing failures live", () => {
	const retry: SessionRetry = {
		attempt: 2,
		maxAttempts: 3,
		delayMs: 4000,
		startedAt: 0,
		errorMessage: "504 b",
	};
	const items = timelineFromEntries([user("u"), failed("e1", "504 a"), failed("e2", "504 b")], retry);
	assert.deepEqual(items.at(-1), { itemId: "retry-e1", kind: "retry", errors: ["504 a", "504 b"], live: retry });
	// The snapshot can name a retry before the failed attempt is listed.
	const early = timelineFromEntries([user("u")], retry);
	assert.deepEqual(early.at(-1), { itemId: "retry-live", kind: "retry", errors: ["504 b"], live: retry });
});
