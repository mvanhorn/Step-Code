import assert from "node:assert/strict";
import test from "node:test";
import { openSession } from "../client/src/state/session.ts";
import { createInitialState, getState, setState } from "../client/src/state/store.ts";

for (const reportErrors of [false, true]) {
	test(`session open ${reportErrors ? "reports errors by default" : "can quietly refuse an unavailable import"}`, async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		setState({ ...createInitialState(), current: { id: "existing", cwd: "/project", status: "idle" } });
		t.after(() => setState(createInitialState()));
		t.mock.method(globalThis, "fetch", async () => Response.json({ error: "technical open diagnostic" }, { status: 500 }));
		if (reportErrors) await openSession("unavailable");
		else await openSession("unavailable", { reportErrors: false });
		assert.equal(getState().current?.id, "existing");
		assert.equal(getState().ui.openingSession, null);
		assert.equal(getState().toast?.message, reportErrors ? "technical open diagnostic" : undefined);
	});
}

test("quiet migration session opening still reports expired authentication globally", async (t) => {
	setState(createInitialState());
	t.after(() => setState(createInitialState()));
	t.mock.method(globalThis, "fetch", async () => Response.json({ error: "unauthorized" }, { status: 401 }));
	await openSession("unavailable", { reportErrors: false });
	assert.equal(getState().ui.authExpired, true);
	assert.equal(getState().toast, null);
	assert.equal(getState().ui.openingSession, null);
});
