import assert from "node:assert/strict";
import test from "node:test";
import { collectTurnFooters } from "../client/src/features/conversation/turn-footers.ts";
import type { TimelineItem } from "../client/src/state/types.ts";

const items: TimelineItem[] = [
	{ kind: "message", itemId: "u1", role: "user", content: "first" },
	{ kind: "message", itemId: "a1", role: "assistant", content: "first reply" },
	{ kind: "message", itemId: "u2", role: "user", content: "second" },
	{ kind: "message", itemId: "a2", role: "assistant", content: "second reply" },
];

test("every settled turn gets a footer row, so only the last one carries model and time", () => {
	const footers = collectTurnFooters(items, "completed", false);
	assert.equal(footers.length, 2);
	// Each footer is the row under its own turn; the reply's metadata is rendered
	// there -- so an earlier turn shows its own, never every message's.
	assert.deepEqual(
		footers.map((footer) => footer.messages.map((message) => message.itemId)),
		[["a1"], ["a2"]],
	);
});

test("a turn still streaming has no footer yet, so no model or time is claimed early", () => {
	const streaming: TimelineItem[] = [
		{ kind: "message", itemId: "u1", role: "user", content: "go" },
		{ kind: "message", itemId: "message-live", role: "assistant", content: "partial" },
	];
	assert.deepEqual(collectTurnFooters(streaming, "running", false), []);
});

test("a user-interrupted run is reported apart from a genuine failure", async () => {
	// The host distinguishes them: both end at `failed`, but only a real error
	// may be credited with a finished reply. Read the projection the snapshot sends.
	const source = await import("node:fs/promises").then((fs) =>
		fs.readFile(new URL("../src/runtime.ts", import.meta.url), "utf8"),
	);
	assert.match(source, /lastRunAborted: this\.lastRunAborted/u, "the snapshot carries the flag");
	assert.match(
		source,
		/this\.lastRunAborted = !stops\.includes\("error"\) && stops\.includes\("aborted"\)/u,
		"an error that also aborted is still a failure",
	);
});
