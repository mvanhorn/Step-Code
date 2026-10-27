/**
 * What the composer's slash menu lists, without React: the built-in commands,
 * the prompt commands and the skills matching a query, and the groups the
 * menu renders. A group with nothing in it is not rendered at all, so a
 * workspace without prompt commands shows no "plugin commands" heading.
 */

import type { MessageKey, TranslateFn } from "../../i18n";
import { fuzzyFilter } from "../../lib/fuzzy";
import type { WebPromptCommand, WebSkill } from "../../state/types";

export interface SlashItem {
	/**
	 * `command` and `prompt` insert `/<key> `, `mcp` opens the MCP view,
	 * `feedback` opens the feedback dialog, `skill` inserts `/skill:<key> `.
	 */
	readonly kind: "command" | "mcp" | "feedback" | "prompt" | "skill";
	readonly key: string;
	readonly title: string;
	readonly description: string;
}

/** The commands the menu offers, in display order. */
const SLASH_COMMANDS: readonly { readonly name: string; readonly description: MessageKey }[] = [
	{ name: "goal", description: "goalCommandDesc" },
	{ name: "init", description: "initCommandDesc" },
	{ name: "plan", description: "planCommandDesc" },
	{ name: "btw", description: "btwCommandDesc" },
	{ name: "compact", description: "compactCommandDesc" },
	{ name: "feedback", description: "feedbackCommandDesc" },
	{ name: "mcp", description: "mcpCommandDesc" },
];

/** `find-skills` -> `Find Skills`. */
function skillTitle(name: string): string {
	return name
		.split(/[-_:\s]+/)
		.filter(Boolean)
		.map((word) => word[0].toUpperCase() + word.slice(1))
		.join(" ");
}

/**
 * The word of a prompt body that is a single `/word` (including a `skill:`
 * prefix), or null. Leading spaces are the separators after staged lead chips.
 */
export function slashQuery(value: string): string | null {
	const match = /^\s*\/(\S*)$/.exec(value);
	return match ? match[1] : null;
}

/** The part of a slash query the items are matched against. */
export function matchText(query: string): string {
	return query.replace(/^skill:/i, "");
}

export interface SlashGroups {
	readonly commands: readonly SlashItem[];
	readonly prompts: readonly SlashItem[];
	readonly skills: readonly SlashItem[];
}

/**
 * Commands, prompt commands and skills matching `query`, each group best first
 * and in display order when the query is empty. A `skill:` prefix asks for
 * skills only. A prompt command named like a built-in command never runs (the
 * command wins in the kernel), so it is not offered.
 */
export function slashGroups(
	query: string,
	skills: readonly WebSkill[],
	t: TranslateFn,
	prompts: readonly WebPromptCommand[] = [],
): SlashGroups {
	const wanted = matchText(query);
	const skillsOnly = /^skill:/i.test(query);
	const builtIn = new Set(SLASH_COMMANDS.map((command) => command.name));
	const promptItems = skillsOnly
		? []
		: prompts
				.filter((prompt) => !builtIn.has(prompt.name))
				.map(
					(prompt): SlashItem => ({
						kind: "prompt",
						key: prompt.name,
						title: `/${prompt.name}`,
						description: prompt.argumentHint
							? `${prompt.argumentHint} · ${prompt.description}`
							: prompt.description,
					}),
				);
	const commands = skillsOnly
		? []
		: SLASH_COMMANDS.map(
				(command): SlashItem => ({
					kind: command.name === "mcp" ? "mcp" : command.name === "feedback" ? "feedback" : "command",
					key: command.name,
					title: `/${command.name}`,
					description: t(command.description),
				}),
			);
	const skillItems = skills.map(
		(skill): SlashItem => ({
			kind: "skill",
			key: skill.name,
			title: skillTitle(skill.name),
			description: skill.description,
		}),
	);
	return {
		commands: fuzzyFilter(commands, wanted, (item) => item.key),
		prompts: fuzzyFilter(promptItems, wanted, (item) => item.key),
		skills: fuzzyFilter(skillItems, wanted, (item) => item.key),
	};
}

/** One rendered group: its items and where they start in the keyboard order. */
export interface SlashSection {
	readonly id: "commands" | "prompts" | "skills";
	readonly label: string;
	readonly items: readonly SlashItem[];
	/** Index of the first item in the one list keyboard selection runs through. */
	readonly offset: number;
}

/**
 * The groups to render, in display order, each with its keyboard offset. An
 * empty group is left out — no heading without items — so with no prompt
 * commands installed the menu shows only commands and skills.
 */
export function slashSections(
	groups: SlashGroups,
	labels: { readonly commands: string; readonly prompts: string; readonly skills: string },
): SlashSection[] {
	const sections: SlashSection[] = [];
	let offset = 0;
	for (const id of ["commands", "prompts", "skills"] as const) {
		const items = groups[id];
		if (items.length === 0) continue;
		sections.push({ id, label: labels[id], items, offset });
		offset += items.length;
	}
	return sections;
}
