import assert from "node:assert/strict";
import test from "node:test";
import {
	COMPACT_MODEL_COUNT,
	compactCandidates,
	groupModelsBySource,
	isStepModel,
} from "../client/src/features/composer/models.ts";
import type { ModelInfo } from "../client/src/state/types.ts";

function model(provider: string, id: string): ModelInfo {
	return { provider, id, name: id, api: "openai-completions" } as ModelInfo;
}

/**
 * The reported case: a signed-in Step Plan account plus a custom gateway that
 * exposes hundreds of ids. The flat list arrived provider-by-provider, so the
 * account's five models sat behind 300+ custom ones and never reached the view.
 */
const ACCOUNT = ["step-5-preview", "step-3.7-flash", "step-router-v1"].map((id) => model("step", id));
const CUSTOM = Array.from({ length: 300 }, (_, index) => model("my-gateway", `custom-${index}`));
const MIXED = [...CUSTOM, ...ACCOUNT];

test("account models are recognised by their provider, custom models are not", () => {
	assert.equal(isStepModel(model("step", "step-5-preview")), true);
	assert.equal(isStepModel(model("my-gateway", "step-5-preview")), false);
});

test("both sources are grouped, the account's models first", () => {
	const groups = groupModelsBySource(MIXED);
	assert.deepEqual(
		groups.map((group) => group.source),
		["account", "custom"],
	);
	assert.equal(groups[0].models.length, ACCOUNT.length);
	assert.equal(groups[1].models.length, CUSTOM.length);
});

test("a single source needs no heading of its own", () => {
	assert.deepEqual(
		groupModelsBySource(CUSTOM).map((group) => group.source),
		["custom"],
	);
	assert.deepEqual(groupModelsBySource([]), []);
});

test("the compact view shows the account's models ahead of a large custom provider", () => {
	const shown = compactCandidates(MIXED, [], undefined);
	assert.equal(shown.length, COMPACT_MODEL_COUNT);
	assert.deepEqual(
		shown.map((entry) => entry.provider),
		["step", "step", "step"],
		"a signed-in account's own models must be visible without opening the full list",
	);
});

test("a pinned or active custom model still appears next to the account's models", () => {
	// Both sources stay reachable: the pinned/active one first, the account's own
	// models filling the rest of the compact view.
	const pinned = compactCandidates(MIXED, ["my-gateway\u0000custom-7"], undefined);
	assert.equal(pinned.some((entry) => entry.id === "custom-7"), true);
	assert.equal(pinned.some((entry) => entry.provider === "step"), true);

	const active = compactCandidates(MIXED, [], model("my-gateway", "custom-9"));
	assert.equal(active[0]?.id, "custom-9");
	assert.equal(active.some((entry) => entry.provider === "step"), true);
});

test("without a Step account the custom provider fills the view as before", () => {
	const shown = compactCandidates(CUSTOM, [], undefined);
	assert.equal(shown.length, COMPACT_MODEL_COUNT);
	assert.equal(shown.every((entry) => entry.provider === "my-gateway"), true);
});
