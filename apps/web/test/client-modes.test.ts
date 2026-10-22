/**
 * Session modes are single-shot: a mode rides one message and is consumed.
 *
 * Picking one used to type `/ultraloop on`, `/goal clear` or a bare `/plan` into
 * the prompt and keep it on for the session, so switching one off took a second
 * command and the input showed keywords the user never wrote.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { chooseMode, clearModes, modePrefix } from "../client/src/features/composer/actions.ts";
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
