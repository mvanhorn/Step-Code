import assert from "node:assert/strict";
import test from "node:test";
import type { StepAccountProfileOutcome } from "@step-harness/coding-agent";
import { AccountProfileCache, toAccountReport } from "../src/account.ts";

const ready: StepAccountProfileOutcome = {
	status: "ready",
	account: { name: "Ada", avatarUrl: "https://cdn.example.test/a.png", uid: "42", profile: "step_plan" },
};

test("the report carries only the display name and avatar", () => {
	const report = toAccountReport(ready);
	assert.deepEqual(report, { status: "ready", account: { name: "Ada", avatarUrl: "https://cdn.example.test/a.png" } });
	assert.equal(JSON.stringify(report).includes("42"), false);
	assert.deepEqual(toAccountReport({ status: "expired", reason: "token is illegal" }), { status: "expired" });
	assert.deepEqual(toAccountReport({ status: "missing" }), { status: "missing" });
});

test("lookups are shared while in flight and cached afterwards", async () => {
	let calls = 0;
	let now = 0;
	const cache = new AccountProfileCache(
		async () => {
			calls += 1;
			return ready;
		},
		() => now,
	);
	const [first, second] = await Promise.all([cache.get(), cache.get()]);
	assert.equal(calls, 1);
	assert.deepEqual(first, second);
	now += 60_000;
	await cache.get();
	assert.equal(calls, 1, "a live profile is kept for minutes");
	now += 10 * 60_000;
	await cache.get();
	assert.equal(calls, 2);
});

test("an absent account is asked again soon, and a sign-in invalidates the cache", async () => {
	let outcome: StepAccountProfileOutcome = { status: "missing" };
	let calls = 0;
	let now = 0;
	const cache = new AccountProfileCache(
		async () => {
			calls += 1;
			return outcome;
		},
		() => now,
	);
	assert.deepEqual(await cache.get(), { status: "missing" });
	now += 31_000;
	await cache.get();
	assert.equal(calls, 2);
	outcome = ready;
	cache.invalidate();
	assert.equal((await cache.get()).account?.name, "Ada");
	assert.equal(calls, 3);
});

test("a lookup that throws is reported as unavailable", async () => {
	const cache = new AccountProfileCache(async () => {
		throw new Error("disk on fire");
	});
	assert.deepEqual(await cache.get(), { status: "unavailable" });
});

test("a result that lands after a sign-in is not cached", async () => {
	let release: (value: StepAccountProfileOutcome) => void = () => {};
	let calls = 0;
	const cache = new AccountProfileCache(() => {
		calls += 1;
		return calls === 1
			? new Promise<StepAccountProfileOutcome>((resolve) => {
					release = resolve;
				})
			: Promise.resolve(ready);
	});
	const stale = cache.get();
	cache.invalidate();
	release({ status: "missing" });
	assert.deepEqual(await stale, { status: "missing" });
	assert.equal((await cache.get()).status, "ready");
	assert.equal(calls, 2);
});
