import assert from "node:assert/strict";
import test from "node:test";
import { backgroundSessionBusy, foldLiveStatuses } from "../client/src/state/session.ts";
import type { SessionSnapshot, SessionStatus } from "../client/src/state/types.ts";

function state(current: string | null, statuses: Record<string, SessionStatus>, unread: Record<string, boolean> = {}) {
	return {
		current: current ? ({ id: current, status: statuses[current] ?? "idle" } as SessionSnapshot) : null,
		statusById: new Map(Object.entries(statuses)),
		unreadById: new Map(Object.entries(unread)),
	};
}

test("a run that ended in the background turns from running into an unread completion", () => {
	const before = state("viewing", { viewing: "running", left: "running" });
	assert.equal(backgroundSessionBusy(before), true);
	const after = foldLiveStatuses(before, [{ id: "left", status: "completed", unread: true }], ["left"]);
	assert.equal(after.statusById.get("left"), "completed");
	assert.equal(after.unreadById.get("left"), true);
	assert.equal(backgroundSessionBusy({ ...before, ...after }), false);
});

test("a session the host no longer holds open falls back to its saved state", () => {
	// The stale "running" the page kept when it left the session must not outlive the host's answer.
	const after = foldLiveStatuses(state(null, { gone: "running" }, { gone: true }), [], ["gone"]);
	assert.equal(after.statusById.has("gone"), false);
	assert.equal(after.unreadById.has("gone"), false);
});

test("the followed session keeps its own stream's status", () => {
	const before = state("viewing", { viewing: "running" });
	const after = foldLiveStatuses(before, [{ id: "viewing", status: "completed", unread: true }], ["viewing"]);
	assert.equal(after.statusById.get("viewing"), "running");
	assert.equal(after.unreadById.has("viewing"), false);
	// Only other sessions count as running in the background.
	assert.equal(backgroundSessionBusy(before), false);
});
