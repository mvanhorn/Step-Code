import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cancelBrowserSignIn, signInWithApiKey, signInWithBrowser } from "../client/src/features/login/actions.ts";
import { createInitialState, getState, setState } from "../client/src/state/store.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
	setState(createInitialState());
});
const report = { source: "auth.json", configured: true, validity: "valid", profile: "platform_cn", loginCommand: "step login" };

test("API key sign-in updates the account projection, but an aborted page never publishes a late response", async () => {
	setState(createInitialState());
	let finish!: () => void;
	globalThis.fetch = async () => {
		await new Promise<void>((resolve) => { finish = resolve; });
		return Response.json({ login: report });
	};
	const controller = new AbortController();
	const pending = signInWithApiKey("platform_cn", "fixture-only", controller.signal);
	controller.abort();
	finish();
	assert.equal((await pending).kind, "ok");
	assert.equal(getState().login, null);
	globalThis.fetch = async () => Response.json({ login: report });
	assert.equal((await signInWithApiKey("platform_cn", "fixture-only")).kind, "ok");
	assert.deepEqual(getState().login, report);
});

test("API key rejection and provider outage retain distinct feedback without replacing the account", async () => {
	for (const code of ["invalid_key", "unavailable"]) {
		globalThis.fetch = async () => Response.json({ code, error: "fixture" }, { status: 400 });
		assert.equal((await signInWithApiKey("platform_cn", "fixture-only")).kind, code === "invalid_key" ? "invalid" : "unavailable");
		assert.equal(getState().login, null);
	}
});

test("a failed browser start is reported without waiting for a poll", async () => {
	globalThis.fetch = async () => Response.json({ state: "failed", error: "fixture start failure" });
	await assert.rejects(signInWithBrowser("step_plan", () => {}), /fixture start failure/);
});

test("cancel waits for an in-flight start and a replacement start waits for cleanup", async () => {
	const calls: string[] = [];
	let finishStart!: () => void;
	let finishDelete!: () => void;
	globalThis.fetch = async (_url, init) => {
		const method = init?.method ?? "GET";
		calls.push(method);
		if (calls.length === 1) await new Promise<void>((resolve) => { finishStart = resolve; });
		if (method === "DELETE") await new Promise<void>((resolve) => { finishDelete = resolve; });
		return Response.json({ state: method === "POST" ? "failed" : "idle", error: "replacement fixture" });
	};
	const first = signInWithBrowser("step_plan", () => assert.fail("cancelled start must not open a URL"));
	await new Promise((resolve) => setImmediate(resolve));
	cancelBrowserSignIn();
	const next = signInWithBrowser("step_plan_oversea", () => {});
	const rejected = assert.rejects(next, /replacement fixture/);
	assert.deepEqual(calls, ["POST"]);
	finishStart();
	assert.equal(await first, "cancelled");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(calls, ["POST", "DELETE"]);
	finishDelete();
	await rejected;
	assert.deepEqual(calls, ["POST", "DELETE", "POST"]);
});
