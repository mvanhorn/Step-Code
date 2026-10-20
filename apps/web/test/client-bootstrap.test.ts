/**
 * `bootstrap()` opens a conversation only if the user has not chosen one while
 * it was loading the workspace and session lists. Everything it touches is the
 * browser (fetch, location, history, EventSource), so the test drives it with
 * a scripted fetch and stubs those globals.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { bootstrap, startDraft } from "../client/src/state/session.ts";
import { getState } from "../client/src/state/store.ts";

const SESSION = {
	id: "restored-session",
	title: "Restored",
	cwd: "/work/restored",
	status: "idle",
	updatedAt: "2026-10-20T00:00:00.000Z",
	createdAt: "2026-10-20T00:00:00.000Z",
};

const SNAPSHOT = {
	...SESSION,
	entries: [],
	retry: null,
	policies: [{ id: "ask", label: "Ask", description: "" }],
	permissionPreset: "ask",
};

type Globals = Record<string, unknown>;
const globals = globalThis as unknown as Globals;
const saved: Globals = {};

/** A response queue for the bootstrap sequence; the session list stays pending until released. */
function scriptedFetch(): void {
	let releaseSessions: () => void = () => {};
	const sessionsGate = new Promise<void>((resolve) => {
		releaseSessions = resolve;
	});
	saved.releaseSessions = releaseSessions;
	globals.fetch = async (path: string) => {
		const url = String(path);
		if (url.startsWith("/api/v1/bootstrap")) return Response.json({ cwd: "/work/launch", directoryPicker: "browse" });
		if (url.startsWith("/api/v1/workspaces")) return Response.json({ workspaces: [] });
		if (url.startsWith("/api/v1/sessions/")) return Response.json(SNAPSHOT);
		if (url.startsWith("/api/v1/sessions")) {
			await sessionsGate;
			return Response.json({ sessions: [SESSION] });
		}
		if (url.startsWith("/api/v1/models")) return Response.json({ availableThinkingLevels: [], models: [] });
		return Response.json({});
	};
}

before(() => {
	for (const key of ["fetch", "location", "history", "EventSource"] as const) saved[key] = globals[key];
	globals.location = { hash: "", search: "", pathname: "/" };
	globals.history = { replaceState: () => {} };
	globals.EventSource = class {
		addEventListener(): void {}
		close(): void {}
	};
	scriptedFetch();
});

after(() => {
	for (const [key, value] of Object.entries(saved)) {
		if (key === "releaseSessions") continue;
		globals[key] = value;
	}
});

test("a draft the user starts while bootstrap loads the session list is not replaced by the first session", async () => {
	const running = bootstrap();
	// The page knows its launch folder before it lists sessions, so the pivot is usable now.
	await until(() => getState().bootstrapCwd === "/work/launch", "the launch folder");
	// The click lands while `GET /api/v1/sessions` is still in flight.
	startDraft("/work/launch");
	(saved.releaseSessions as () => void)();
	await running;

	const state = getState();
	assert.equal(state.current, null, "the late session list must not open a session over the draft");
	assert.equal(state.draftCwd, "/work/launch", "the draft stays on the folder it was started in");
});

async function until(probe: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!probe()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}
