import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createStepSessionManager,
	openSessionIndex,
	type SessionFilePersistedEvent,
	type SessionIndex,
	SessionSearchRequestError,
} from "@step-harness/coding-agent";
import { searchParamsFromUrl, WebSessionSearch } from "../src/session-search.ts";

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.fail(`timed out waiting for ${what}`);
}

test("indexes session writes and answers content and short queries", async () => {
	const agentDir = await realpath(await mkdtemp(join(tmpdir(), "stepcode-web-search-")));
	const search = new WebSessionSearch(agentDir, (dir) => openSessionIndex({ agentDir: dir, debounceMs: 10 }));
	try {
		const manager = createStepSessionManager("/work/app", { agentDir });
		manager.setFilePersistedListener((event) => search.notifyPersisted(event));
		manager.appendMessage({ role: "user", content: "rename the migration helper 迁移脚本", timestamp: Date.now() });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "faux",
			provider: "faux",
			model: "faux",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		await until(async () => (await search.search({ q: "migration" })).hits.length > 0, "the content hit");
		const result = await search.search({ q: "migration" });
		const hit = result.hits.find((candidate) => candidate.entryId !== null);
		assert.equal(hit?.sessionId, manager.getSessionId());
		assert.equal(hit?.cwd, "/work/app");
		assert.equal(hit?.role, "user");
		assert.match(hit?.snippet ?? "", /\u0002migration\u0003/);
		assert.equal(result.state, "ready");
		assert.deepEqual(result.coverage, { indexed: 1, total: 1 });

		// Two characters: below the trigram minimum, answered by the bounded LIKE path.
		assert.equal((await search.search({ q: "迁移", cwd: "/work/app" })).hits.length > 0, true);

		const status = await search.status();
		assert.equal(status.state, "ready");
		assert.equal("dbPath" in status, false);
	} finally {
		await search.close();
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("rejects invalid parameters with the service's error code", async () => {
	const agentDir = await realpath(await mkdtemp(join(tmpdir(), "stepcode-web-search-")));
	const search = new WebSessionSearch(agentDir, (dir) => openSessionIndex({ agentDir: dir, backfill: false }));
	try {
		for (const params of [{ q: "" }, { q: "abc", cwd: "relative" }, { q: "abc", limit: Number.NaN }]) {
			await assert.rejects(
				search.search(params),
				(error: unknown) => error instanceof SessionSearchRequestError && error.code === "invalid_params",
			);
		}
	} finally {
		await search.close();
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("forwards writes reported before the index finished opening", async () => {
	const received: SessionFilePersistedEvent[] = [];
	let finishOpening: (index: SessionIndex) => void = () => {};
	const index = {
		notifyPersisted: (event: SessionFilePersistedEvent) => received.push(event),
		close: async () => {},
	} as unknown as SessionIndex;
	const search = new WebSessionSearch(
		"/unused",
		() =>
			new Promise<SessionIndex>((resolve) => {
				finishOpening = resolve;
			}),
	);
	const event: SessionFilePersistedEvent = { path: "/s.jsonl", kind: "append" };
	search.notifyPersisted(event);
	assert.equal(received.length, 0);
	finishOpening(index);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(received, [event]);
	search.notifyPersisted(event);
	assert.equal(received.length, 2);
	await search.close();
});

test("reads search parameters from the URL", () => {
	assert.deepEqual(searchParamsFromUrl(new URL("http://h/api/v1/search")), { q: "" });
	assert.deepEqual(searchParamsFromUrl(new URL("http://h/api/v1/search?q=a%20b&cwd=%2Fw&limit=5")), {
		q: "a b",
		cwd: "/w",
		limit: 5,
	});
	assert.equal(Number.isNaN(searchParamsFromUrl(new URL("http://h/?q=x&limit=ten")).limit), true);
});
