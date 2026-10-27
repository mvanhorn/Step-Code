/**
 * The slash menu's groups: the "plugin commands" heading appears only
 * when there is at least one prompt command to show under it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { slashGroups, slashSections } from "../client/src/features/composer/slash-groups.ts";
import type { TranslateFn } from "../client/src/i18n/index.ts";

const t = ((key: string) => key) as TranslateFn;
const LABELS = { commands: "命令", prompts: "插件命令", skills: "技能" };
const SKILLS = [{ name: "pdf", description: "PDF tools" }];

test("with no prompt commands the group is not rendered", () => {
	const sections = slashSections(slashGroups("", SKILLS, t, []), LABELS);
	assert.deepEqual(
		sections.map((section) => section.id),
		["commands", "skills"],
	);
	// Keyboard order stays continuous across the groups that remain.
	assert.equal(sections[1]?.offset, sections[0]?.items.length);
});

test("a query that matches no prompt command hides the group too", () => {
	const prompts = [{ name: "code-review", description: "Review a pull request" }];
	const sections = slashSections(slashGroups("pdf", SKILLS, t, prompts), LABELS);
	assert.equal(
		sections.some((section) => section.id === "prompts"),
		false,
	);
});

test("prompt commands get their own group between commands and skills", () => {
	const prompts = [{ name: "code-review", description: "Review a pull request", argumentHint: "<pr>" }];
	const sections = slashSections(slashGroups("", SKILLS, t, prompts), LABELS);
	assert.deepEqual(
		sections.map((section) => [section.id, section.label]),
		[
			["commands", "命令"],
			["prompts", "插件命令"],
			["skills", "技能"],
		],
	);
	const group = sections[1];
	assert.equal(group?.offset, sections[0]?.items.length);
	assert.deepEqual(group?.items, [
		{ kind: "prompt", key: "code-review", title: "/code-review", description: "<pr> · Review a pull request" },
	]);
	assert.equal(sections[2]?.offset, (group?.offset ?? 0) + 1);
});

test("a prompt command named like a built-in command is not offered, so it cannot open the group alone", () => {
	const sections = slashSections(slashGroups("", [], t, [{ name: "goal", description: "shadowed" }]), LABELS);
	assert.deepEqual(
		sections.map((section) => section.id),
		["commands"],
	);
});
