/**
 * The sent-message bubble: right-aligned, growing leftwards, with a width cap.
 *
 * Layout is CSS, so this guards the rule that produces it rather than the pixels.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../client/src/features/conversation/stream.css", import.meta.url), "utf8");

function rule(selector: string): string {
	const start = css.indexOf(`${selector} {`);
	assert.notEqual(start, -1, `missing rule: ${selector}`);
	const end = css.indexOf("}", start);
	return css.slice(start, end);
}

test("a sent bubble shrinks to its text instead of spanning the column", () => {
	const body = rule(".message.user .message-body");
	assert.match(body, /width:\s*fit-content/u, "the bubble must size to its text");
	assert.doesNotMatch(body, /width:\s*100%/u, "a full-width bubble pins the text to the left");
});

test("a sent bubble stops widening at a readable cap", () => {
	const body = rule(".message.user .message-body");
	assert.match(body, /max-width:\s*min\(100%,\s*[\d.]+ch\)/u, "a long prompt wraps instead of growing without bound");
});

test("a sent message stays right-aligned", () => {
	assert.match(rule(".message.user"), /align-items:\s*flex-end/u);
});
