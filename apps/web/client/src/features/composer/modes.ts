/**
 * The three session modes' presentation metadata, shared by the ＋ menu's mode
 * rows, the prompt's mode lead chip and its mode placeholder. The per-mode
 * accent colour lives in composer.css (`--mode-*` on `.composer`); this file
 * carries only the icon and copy keys, so a new mode is one entry here plus one
 * accent there.
 */

import type { ModeId } from "../../state/store";
import type { IconName } from "../../ui";

export const MODES: ReadonlyArray<{
	readonly id: ModeId;
	readonly icon: IconName;
	readonly labelKey: string;
	readonly descKey: string;
	/** The prompt's placeholder while the mode is staged: coaches what to type. */
	readonly placeholderKey: string;
}> = [
	{
		id: "goal",
		icon: "target",
		labelKey: "modeGoal",
		descKey: "modeGoalDesc",
		placeholderKey: "modeGoalPlaceholder",
	},
	{
		id: "plan",
		icon: "listCheck",
		labelKey: "modePlan",
		descKey: "modePlanDesc",
		placeholderKey: "modePlanPlaceholder",
	},
	{
		id: "ultraloop",
		icon: "orbit",
		labelKey: "modeUltraloop",
		descKey: "modeUltraloopDesc",
		placeholderKey: "modeUltraloopPlaceholder",
	},
];
