import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { BrowserConnection } from "../client/src/features/browser/actions.ts";

test("browser snapshots never regress across command responses, heartbeat and SSE", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const snapshots: number[] = [];
	let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
	let command: ((response: Response) => void) | undefined;
	let heartbeat: ((response: Response) => void) | undefined;
	let reads = 0;
	const snapshot = (revision: number) => ({ revision, activeId: null, tabs: [] });
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const path = String(input);
		if (path.endsWith("/control")) return Response.json({ token: "fixture-token" });
		if (path.endsWith("/events")) return new Response(new ReadableStream<Uint8Array>({
			start(controller) { stream = controller; },
		}));
		if (init?.method === "POST") return new Promise<Response>((resolve) => { command = resolve; });
		if (reads++ === 0) return Response.json(snapshot(0));
		return new Promise<Response>((resolve) => { heartbeat = resolve; });
	});
	const errors: unknown[] = [];
	const client = new BrowserConnection((state) => snapshots.push(state.revision), () => {}, (error) => errors.push(error));
	const publish = async (revision: number) => {
		stream?.enqueue(new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify(snapshot(revision))}\n\n`));
		await nextTurn();
	};
	try {
		await client.connect();
		client.send("/tabs/old/select");
		await nextTurn();
		await publish(2);
		command?.(Response.json(snapshot(1)));
		await nextTurn();
		t.mock.timers.tick(5000);
		await nextTurn();
		await publish(4);
		heartbeat?.(Response.json(snapshot(3)));
		await nextTurn();
		await publish(4);
		await publish(2);
		await publish(-1);
		await publish(4.5);
		await publish(5);
		assert.deepEqual(snapshots, [0, 2, 4, 5]);
		assert.deepEqual(errors, []);
		client.send("/tabs/new/select");
		await nextTurn();
		client.close();
		command?.(Response.json(snapshot(6)));
		await nextTurn();
		assert.deepEqual(snapshots, [0, 2, 4, 5], "Closed connections must not publish late responses");
	} finally {
		client.close();
		stream?.close();
		await nextTurn();
	}
});

test("a heartbeat tolerates transient failures and drops only after three in a row", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	let beat = 0;
	let failing = false;
	const snapshots: number[] = [];
	const errors: Array<{ disconnected: boolean }> = [];
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const path = String(input);
		if (path.endsWith("/control")) return Response.json({ token: "fixture-token" });
		if (path.endsWith("/events")) return new Response(new ReadableStream<Uint8Array>({ start() {} }));
		beat++;
		if (failing) throw new Error("heartbeat failed");
		return Response.json({ revision: beat, activeId: null, tabs: [] });
	});
	const client = new BrowserConnection(
		(snapshot) => snapshots.push(snapshot.revision),
		() => {},
		(_error, disconnected) => errors.push({ disconnected }),
	);
	try {
		await client.connect();
		failing = true;
		t.mock.timers.tick(5000);
		t.mock.timers.tick(5000);
		await nextTurn();
		assert.deepEqual(errors, [], "two missed heartbeats are not a lost Host");
		failing = false;
		t.mock.timers.tick(5000);
		await nextTurn();
		assert.equal(snapshots.at(-1), 4);
		failing = true;
		t.mock.timers.tick(5000);
		t.mock.timers.tick(5000);
		await nextTurn();
		assert.deepEqual(errors, []);
		t.mock.timers.tick(5000);
		await nextTurn();
		assert.deepEqual(errors, [{ disconnected: true }]);
	} finally {
		client.close();
	}
});

function wheelFixture(t: TestContext) {
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
	const inputs: Array<Record<string, unknown>> = [];
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const path = String(input);
		if (path.endsWith("/control")) return Response.json({ token: "fixture-token" });
		if (path.endsWith("/events")) return new Response(new ReadableStream<Uint8Array>({ start() {} }));
		if (path.endsWith("/input")) inputs.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		return Response.json({ revision: 1, activeId: "one", tabs: [] });
	});
	const client = new BrowserConnection(
		() => {},
		() => {},
		() => {},
	);
	return { client, inputs };
}

test("wheel input is coalesced per frame and keeps the whole scroll distance", async (t) => {
	const { client, inputs } = wheelFixture(t);
	try {
		await client.connect();
		for (let index = 0; index < 8; index++)
			client.wheel("/tabs/one/input", { x: 10 + index, y: 20, deltaX: 0, deltaY: 100 });
		assert.equal(inputs.length, 0, "a burst waits for the frame instead of queueing every event");
		t.mock.timers.tick(40);
		await nextTurn();
		assert.deepEqual(inputs, [{ kind: "wheel", x: 17, y: 20, deltaX: 0, deltaY: 800 }]);
		// A later command flushes the pending delta first, so it observes the scroll position.
		client.wheel("/tabs/one/input", { x: 5, y: 6, deltaX: 10, deltaY: 50 });
		client.send("/tabs/one/input", { kind: "key", key: "PageDown", modifiers: 0 });
		await nextTurn();
		await nextTurn();
		assert.deepEqual(inputs.slice(1), [
			{ kind: "wheel", x: 5, y: 6, deltaX: 10, deltaY: 50 },
			{ kind: "key", key: "PageDown", modifiers: 0 },
		]);
	} finally {
		client.close();
	}
});

test("wheel coalescing flushes before the host bound and when the tab changes", async (t) => {
	const { client, inputs } = wheelFixture(t);
	try {
		await client.connect();
		client.wheel("/tabs/one/input", { x: 1, y: 1, deltaX: 0, deltaY: 4000 });
		client.wheel("/tabs/one/input", { x: 2, y: 1, deltaX: 0, deltaY: 4000 });
		await nextTurn();
		assert.deepEqual(inputs, [{ kind: "wheel", x: 1, y: 1, deltaX: 0, deltaY: 4000 }]);
		t.mock.timers.tick(40);
		await nextTurn();
		assert.equal(inputs.length, 2);
		assert.equal(inputs[1].deltaY, 4000);
		client.wheel("/tabs/one/input", { x: 3, y: 1, deltaX: 0, deltaY: 10 });
		client.wheel("/tabs/two/input", { x: 4, y: 1, deltaX: 0, deltaY: 20 });
		await nextTurn();
		assert.equal(inputs.length, 3, "changing tabs flushes the previous tab first");
		assert.deepEqual(inputs[2], { kind: "wheel", x: 3, y: 1, deltaX: 0, deltaY: 10 });
		t.mock.timers.tick(40);
		await nextTurn();
		assert.deepEqual(inputs[3], { kind: "wheel", x: 4, y: 1, deltaX: 0, deltaY: 20 });
	} finally {
		client.close();
	}
});
