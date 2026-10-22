import assert from "node:assert/strict";
import test from "node:test";
import { clockTime } from "../client/src/features/conversation/message-meta.ts";

test("a message time is shown as 24-hour HH:MM in local time", () => {
	const value = new Date(2026, 9, 22, 9, 5, 30);
	assert.equal(clockTime(value.toISOString()), "09:05");
	const evening = new Date(2026, 9, 22, 23, 59, 0);
	assert.equal(clockTime(evening.toISOString()), "23:59");
});

test("midnight is 00:00 rather than 24:00", () => {
	const midnight = new Date(2026, 9, 22, 0, 0, 0);
	assert.equal(clockTime(midnight.toISOString()), "00:00");
});

test("an unparseable timestamp is passed through instead of inventing a clock", () => {
	assert.equal(clockTime("not-a-date"), "not-a-date");
});
