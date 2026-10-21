import assert from "node:assert/strict";
import { test } from "node:test";
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
