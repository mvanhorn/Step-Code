/**
 * The two cache-hit ratios come from different sums and must say so.
 *
 * The composer footer adds up every response in the session; the Context panel
 * reports the latest response only. They shared one label, so a user reading
 * both saw two numbers under the same name.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const messages = await readFile(new URL("../client/src/i18n/messages.ts", import.meta.url), "utf8");
const bar = await readFile(
	new URL("../client/src/features/composer/PerformanceBar.tsx", import.meta.url),
	"utf8",
);
const panel = await readFile(
	new URL("../client/src/features/inspector/ContextPanel.tsx", import.meta.url),
	"utf8",
);

test("the footer and the panel use different keys", () => {
	assert.match(bar, /t\("performanceCacheHit"\)/u, "the footer needs its own session-scoped key");
	assert.match(panel, /t\("rightCacheHit"\)/u, "the panel keeps the per-response key");
});

test("each label states its scope", () => {
	for (const key of ["performanceCacheHit", "rightCacheHit"]) {
		const line = messages.split("\n").find((entry) => entry.includes(`\t${key}: "`));
		assert.ok(line, `missing ${key}`);
		assert.match(line, /会话累计|本次响应|ession|response/u, `${key} must name its scope`);
	}
	// Both languages carry the key, so neither falls back to the other's wording.
	assert.equal(messages.split('\tperformanceCacheHit: "').length - 1, 2);
});
