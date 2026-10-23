/**
 * Session modes are single-shot: a mode rides one message and is consumed.
 *
 * Picking one used to type `/ultraloop on`, `/goal clear` or a bare `/plan` into
 * the prompt and keep it on for the session, so switching one off took a second
 * command and the input showed keywords the user never wrote.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { chooseMode, clearModes, modePrefix } from "../client/src/features/composer/actions.ts";
import { MODES } from "../client/src/features/composer/modes.ts";
import { MESSAGES } from "../client/src/i18n/messages.ts";
import { createInitialState, getState, setState, type ModeId } from "../client/src/state/store.ts";

function reset(): void {
	const initial = createInitialState();
	setState({ modes: { ...initial.modes } });
}

test("picking a mode stages no text in the prompt", () => {
	reset();
	// The return value is only "is it on"; nothing is written into the composer.
	for (const id of ["goal", "plan", "ultraloop"] as ModeId[]) {
		assert.equal(chooseMode(id), true);
		assert.equal(getState().modes[id], true);
	}
});

test("modes are single-select: picking one clears the others", () => {
	reset();
	chooseMode("goal");
	chooseMode("plan");
	assert.deepEqual(getState().modes, { goal: false, plan: true, ultraloop: false });
});

test("picking an active mode again removes it without sending a clear command", () => {
	reset();
	chooseMode("ultraloop");
	assert.equal(chooseMode("ultraloop"), false);
	assert.deepEqual(getState().modes, { goal: false, plan: false, ultraloop: false });
});

test("each mode maps to the prefix the kernel reads for one turn", () => {
	// `/goal <body>` starts a goal, `/plan <body>` plans that task, and the
	// `ultracode:` keyword is the kernel's own per-turn workflow opt-in
	// (`ultraloop` is its alias and the kernel matches both).
	assert.equal(modePrefix("goal"), "/goal ");
	assert.equal(modePrefix("plan"), "/plan ");
	assert.match(modePrefix("ultraloop"), /^ultracode: ?$/u);
});

test("sending consumes every staged mode", () => {
	reset();
	chooseMode("goal");
	clearModes();
	assert.deepEqual(getState().modes, { goal: false, plan: false, ultraloop: false });
});

test("each mode carries its icon, labels and placeholder in every locale", () => {
	// The staged-mode presentation reads one metadata entry per mode; a key
	// missing from either locale would render as its key string.
	assert.deepEqual(
		MODES.map((mode) => mode.id),
		["goal", "plan", "ultraloop"],
	);
	for (const mode of MODES) {
		assert.ok(mode.icon, `${mode.id}: no icon`);
		for (const key of [mode.labelKey, mode.descKey, mode.placeholderKey]) {
			assert.ok(Object.hasOwn(MESSAGES["zh-CN"], key), `${mode.id}: zh-CN missing ${key}`);
			assert.ok(Object.hasOwn(MESSAGES["en-US"], key), `${mode.id}: en-US missing ${key}`);
		}
	}
});

test("each mode has its accent and chip theme in composer.css", () => {
	// A mode is one metadata entry plus its CSS accent (see modes.ts): the card
	// paints through `[data-mode]`, the chip and the ＋ menu row through their
	// per-mode classes. This keeps a new mode from rendering unthemed.
	const css = readFileSync(new URL("../client/src/features/composer/composer.css", import.meta.url), "utf8");
	for (const mode of MODES) {
		assert.ok(css.includes(`[data-mode="${mode.id}"]`), `${mode.id}: no composer-card accent block`);
		assert.ok(css.includes(`.pick-chip--${mode.id}`), `${mode.id}: no mode chip class`);
		assert.ok(css.includes(`.control-option--${mode.id}`), `${mode.id}: no ＋ menu row class`);
	}
});
