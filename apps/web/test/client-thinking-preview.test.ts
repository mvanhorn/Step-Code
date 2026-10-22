import assert from "node:assert/strict";
import test from "node:test";
import { thinkingPreview } from "../client/src/features/conversation/thinking-preview.ts";

test("the preview keeps whole sentences instead of a trailing character slice", () => {
	const preview = thinkingPreview("Let me check the merge base. Then I compare both sides.");
	assert.ok(preview);
	// Both sentences fit, so nothing is cut mid-sentence.
	assert.equal(preview.text, "Let me check the merge base. Then I compare both sides.");
});

test("the window only grows inside one sentence, and moves once when it ends", () => {
	const head = "First sentence is done. Now the second sentence runs";
	const before = thinkingPreview(head);
	assert.ok(before);
	// Every token of the sentence being written keeps the same window identity, so
	// the line is extended at its tail rather than re-revealed from the start.
	for (const extra of ["，", "，and keeps going", "，and keeps going further"]) {
		const next = thinkingPreview(head + extra);
		assert.ok(next);
		assert.equal(next.key, before.key, `key must stay stable for ${JSON.stringify(extra)}`);
		assert.ok(next.text.startsWith(before.text), "the visible text only grows at its tail");
	}
	const after = thinkingPreview(`${head}，and keeps going forever. A new sentence begins here.`);
	assert.ok(after);
	assert.notEqual(after.key, before.key, "a finished sentence may move the window");
	assert.ok(after.text.endsWith("A new sentence begins here."));
});

test("a single sentence longer than the window is cut at a clause boundary", () => {
	const long = `${"字".repeat(100)}，${"词".repeat(100)}`;
	const preview = thinkingPreview(long);
	assert.ok(preview);
	assert.ok(preview.text.length <= 220, `preview too long: ${preview.text.length}`);
	assert.ok(preview.text.length < long.length, "the over-long sentence is shortened");
});

test("text without punctuation cannot push the preview past its cap", () => {
	const preview = thinkingPreview("x".repeat(500));
	assert.ok(preview);
	assert.ok(preview.text.length <= 220);
});

test("an empty or whitespace-only block has no preview", () => {
	assert.equal(thinkingPreview(""), undefined);
	assert.equal(thinkingPreview("   \n "), undefined);
});

test("newlines and repeated spaces collapse to one readable line", () => {
	const preview = thinkingPreview("第一句。\n\n  第二句\n");
	assert.ok(preview);
	assert.equal(preview.text.includes("\n"), false);
	assert.equal(/ {2}/u.test(preview.text), false);
});
