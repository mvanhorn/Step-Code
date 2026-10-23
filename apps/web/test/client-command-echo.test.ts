/**
 * The client's projection of the host's command echo: the custom entry becomes
 * one `command` timeline row carrying the typed line, and every other custom
 * entry stays invisible to the timeline.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { timelineFromEntries } from "../client/src/state/session.ts";

const ENTRY = {
	id: "e1",
	type: "custom",
	customType: "stepcode-web.command-echo",
	command: "/goal 梳理一下本地文件夹",
	timestamp: "2026-10-23T06:26:26.000Z",
};

test("a command echo becomes one command row with the typed line", () => {
	const items = timelineFromEntries([ENTRY]);
	assert.equal(items.length, 1);
	assert.deepEqual(items[0], {
		itemId: "command-e1",
		kind: "command",
		command: "/goal 梳理一下本地文件夹",
		timestamp: "2026-10-23T06:26:26.000Z",
	});
});

test("other custom entries and empty echoes stay out of the timeline", () => {
	assert.deepEqual(
		timelineFromEntries([{ id: "g1", type: "custom", customType: "step-goal", data: { objective: "x" } }]),
		[],
	);
	assert.deepEqual(
		timelineFromEntries([{ id: "g2", type: "custom", customType: "stepcode-web.command-echo", command: "" }]),
		[],
	);
	// An echo between messages keeps document order.
	const items = timelineFromEntries([
		ENTRY,
		{
			id: "m1",
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "hello" }] },
		},
	]);
	assert.equal(items[0]?.kind, "command");
	assert.equal(items[1]?.kind, "message");
});
