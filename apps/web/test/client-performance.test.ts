import assert from "node:assert/strict";
import test from "node:test";
import {
	observePerformance,
	performanceDuration,
	performanceUsage,
	responseThroughput,
} from "../client/src/state/performance.ts";
import { closeStream, connectStream, renderSnapshot } from "../client/src/state/session.ts";
import { createInitialState, getState, setState } from "../client/src/state/store.ts";
import type { SessionSnapshot } from "../client/src/state/types.ts";

test("performance timing requires an observed start and freezes only at settlement", () => {
	assert.equal(observePerformance(null, { type: "message_end" }, 1000), null);
	const run = observePerformance(null, { type: "agent_start" }, 1000);
	assert.ok(run);
	assert.equal(observePerformance(run, { type: "agent_end" }, 2000), run);
	assert.equal(observePerformance(run, { type: "agent_start" }, 3000), run);
	const done = observePerformance(run, { type: "agent_settled" }, 4000);
	assert.equal(done?.endedAt, 4000);
	assert.equal(observePerformance(done, { type: "agent_settled" }, 9000), done);
	assert.equal(observePerformance(done, { type: "agent_start" }, 10000)?.startedAt, 10000);
	assert.equal(responseThroughput(run), undefined);
});

test("throughput counts reported output once per observed response and excludes tool time", () => {
	let run = observePerformance(null, { type: "agent_start" }, 1000);
	run = observePerformance(run, { type: "message_start", message: { role: "assistant" } }, 1100);
	run = observePerformance(run, { type: "message_end", message: { role: "assistant", usage: { output: 100 } } }, 3100);
	assert.equal(responseThroughput(run), 50);
	run = observePerformance(run, { type: "message_end", message: { role: "assistant", usage: { output: 100 } } }, 3200);
	run = observePerformance(run, { type: "tool_execution_start" }, 3200);
	run = observePerformance(run, { type: "tool_execution_end" }, 203200);
	run = observePerformance(run, { type: "message_start", message: { role: "assistant" } }, 204000);
	run = observePerformance(run, { type: "message_end", message: { role: "assistant", usage: { output: 300 } } }, 208000);
	assert.equal(run?.output, 400);
	assert.equal(run?.responseMs, 6000);
	assert.equal(responseThroughput(run), 400 / 6);
});

test("unreported, malformed and unobserved usage never acquires a generation speed", () => {
	for (const output of [undefined, -1, NaN, Infinity, "100"]) {
		let run = observePerformance(null, { type: "agent_start" }, 1000);
		run = observePerformance(run, { type: "message_end", message: { role: "assistant", usage: { output: 100 } } }, 2000);
		assert.equal(responseThroughput(run), undefined);
		run = observePerformance(run, { type: "message_start", message: { role: "assistant" } }, 3000);
		run = observePerformance(run, { type: "message_end", message: { role: "assistant", usage: { output } } }, 4000);
		assert.equal(responseThroughput(run), undefined);
	}
});

test("canonical cumulative usage includes cache tokens with DFSC's cache denominator", () => {
	assert.equal(performanceUsage(undefined), undefined);
	const stats = { cost: 0, tokens: { input: 60000, output: 28300, cacheRead: 371000, cacheWrite: 0, total: 459300 } };
	assert.deepEqual(performanceUsage(stats), { input: 431000, output: 28300, cacheHit: 371000 / 431000 });
	assert.equal(performanceUsage({ ...stats, tokens: { ...stats.tokens, cacheRead: 0 } })?.cacheHit, undefined);
	assert.equal(performanceUsage({ ...stats, tokens: { ...stats.tokens, cacheRead: 0, cacheWrite: 100 } })?.cacheHit, 0);
	assert.equal(performanceUsage({ ...stats, tokens: { ...stats.tokens, input: NaN } }), undefined);
	assert.equal(performanceUsage({ ...stats, tokens: { ...stats.tokens, output: -1 } }), undefined);
});

test("elapsed display stays compact for seconds, minutes and hours", () => {
	assert.equal(performanceDuration(-1), "0s");
	assert.equal(performanceDuration(59000), "59s");
	assert.equal(performanceDuration(61000), "1m 1s");
	assert.equal(performanceDuration(3661000), "1h 1m");
});

test("same-session snapshots preserve observations; replacement and stream close clear them", () => {
	setState(createInitialState());
	const snapshot: SessionSnapshot = { id: "one", cwd: "D:/Scratch", status: "running", entries: [] };
	renderSnapshot(snapshot);
	const run = observePerformance(null, { type: "agent_start" }, 1000);
	setState({ performanceRun: run });
	renderSnapshot({ ...snapshot, status: "completed" });
	assert.equal(getState().performanceRun, run);
	renderSnapshot({ ...snapshot, id: "two" });
	assert.equal(getState().performanceRun, null);
	setState({ performanceRun: run });
	closeStream();
	assert.equal(getState().performanceRun, null);
	setState(createInitialState());
});

test("SSE agent events feed timing, and stale streams cannot update a replacement", (context) => {
	class FakeEventSource {
		static instances: FakeEventSource[] = [];
		readonly listeners = new Map<string, (event: { data: string }) => void>();
		onerror?: () => void;
		constructor(_url: string) {
			FakeEventSource.instances.push(this);
		}
		addEventListener(name: string, listener: (event: { data: string }) => void) {
			this.listeners.set(name, listener);
		}
		close() {}
		emit(event: unknown) {
			this.listeners.get("agent")?.({ data: JSON.stringify({ event }) });
		}
	}
	context.mock.method(globalThis, "setTimeout", () => 0);
	context.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 503 }));
	const original = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
	Object.defineProperty(globalThis, "EventSource", { value: FakeEventSource, configurable: true });
	try {
		setState(createInitialState());
		renderSnapshot({ id: "one", cwd: "D:/Scratch", status: "running", entries: [] });
		connectStream("one");
		const first = FakeEventSource.instances[0];
		first.emit({ type: "agent_start" });
		assert.ok(getState().performanceRun);
		first.emit({ type: "message_start", message: { role: "assistant" } });
		first.emit({ type: "message_end", message: { role: "assistant", usage: { output: 40 } } });
		assert.equal(getState().performanceRun?.output, 40);
		first.emit({ type: "agent_settled" });
		assert.ok(getState().performanceRun?.endedAt);
		connectStream("two");
		first.emit({ type: "agent_start" });
		assert.equal(getState().performanceRun, null);
		const second = FakeEventSource.instances[1];
		second.emit({ type: "agent_start" });
		first.onerror?.();
		assert.ok(getState().performanceRun, "An obsolete stream must not clear the current observation");
		second.onerror?.();
		assert.equal(getState().performanceRun, null);
	} finally {
		closeStream();
		setState(createInitialState());
		if (original) Object.defineProperty(globalThis, "EventSource", original);
		else Reflect.deleteProperty(globalThis, "EventSource");
	}
});
