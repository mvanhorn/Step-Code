import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
	MAX_VOICE_CHUNK_BYTES,
	resolveVoiceCredential,
	VoiceError,
	VoiceRelay,
	type VoiceCredential,
	type VoiceEvent,
	type VoiceWebSocket,
	type VoiceWebSocketFactory,
} from "../src/voice.ts";
import { voiceRoute } from "../src/voice-routes.ts";

/** A scripted realtime socket: the test drives open, messages and failures. */
class FakeWebSocket implements VoiceWebSocket {
	onopen: (() => void) | null = null;
	onmessage: ((event: { readonly data: string }) => void) | null = null;
	onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null;
	onerror: ((event: { readonly message?: string }) => void) | null = null;
	readonly sent: string[] = [];
	closed = false;

	constructor(
		readonly url: string,
		readonly options: { readonly headers: Record<string, string> },
	) {}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.closed = true;
	}

	open(): void {
		this.onopen?.();
	}

	message(value: unknown): void {
		this.onmessage?.({ data: JSON.stringify(value) });
	}

	fail(message: string): void {
		this.onerror?.({ message });
	}

	serverClose(code = 1006): void {
		this.onclose?.({ code, reason: "" });
	}

	/** Parsed `send` payloads, so assertions read fields rather than strings. */
	sentJson(): Record<string, unknown>[] {
		return this.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
	}
}

/** Hands out the sockets it created, so a test can script them in order. */
function fakeFactory(): { factory: VoiceWebSocketFactory; sockets: FakeWebSocket[] } {
	const sockets: FakeWebSocket[] = [];
	return {
		sockets,
		factory: (url, options) => {
			const socket = new FakeWebSocket(url, options);
			sockets.push(socket);
			return socket;
		},
	};
}

const testCredential: VoiceCredential = {
	key: "test-key",
	keySource: "environment",
	channel: "platform",
	baseUrl: "https://api.stepfun.com/v1",
	model: "stepaudio-3-realtime-preview",
};

function relayWith(factory: VoiceWebSocketFactory, credential: VoiceCredential | undefined = testCredential): VoiceRelay {
	return new VoiceRelay({ resolveCredential: () => credential, webSocket: factory });
}

/** A relay whose resolver finds nothing; `undefined` cannot be the default. */
function relayWithoutCredential(factory: VoiceWebSocketFactory): VoiceRelay {
	return new VoiceRelay({ resolveCredential: () => undefined, webSocket: factory });
}

/**
 * Drive a start through the full handshake: the socket opens, the relay sends
 * `session.update`, and the service confirms with `session.updated` — only
 * then does `start` resolve, exactly as against the live service.
 */
async function startSession(relay: VoiceRelay, sockets: FakeWebSocket[]): Promise<FakeWebSocket> {
	const starting = relay.start();
	assert.equal(sockets.length, 1);
	sockets[0].open();
	sockets[0].message({ type: "session.updated" });
	await starting;
	return sockets[0];
}

/** One PCM16 chunk worth of base64 (100 ms of 24 kHz mono would be ~6.4 KB). */
const audioChunk = Buffer.alloc(4800).toString("base64");

test("voice status reports the channel without the key, and the missing-credential reason", () => {
	const { factory } = fakeFactory();
	const available = relayWith(factory).status();
	assert.deepEqual(available, {
		available: true,
		channel: "platform",
		model: "stepaudio-3-realtime-preview",
		keySource: "environment",
	});
	assert.ok(!JSON.stringify(available).includes("test-key"), "status must not carry the key");

	const missing = relayWithoutCredential(factory).status();
	assert.deepEqual(missing, { available: false, reason: "no-credential" });
});

test("start opens the realtime session with the bearer header and a text-only session update", async () => {
	const { factory, sockets } = fakeFactory();
	const relay = relayWith(factory);
	const events: VoiceEvent[] = [];
	relay.subscribe((event) => events.push(event));

	const starting = relay.start();
	assert.equal(sockets.length, 1);
	const socket = sockets[0];
	assert.equal(socket.url, "wss://api.stepfun.com/v1/realtime?model=stepaudio-3-realtime-preview");
	assert.equal(socket.options.headers.Authorization, "Bearer test-key");
	socket.open();
	// Audio may only flow once the service confirms the session configuration.
	assert.equal(socket.sentJson().length, 1, "nothing but session.update is sent before the confirmation");
	socket.message({ type: "session.updated" });
	const session = await starting;

	const update = socket.sentJson()[0];
	assert.equal(update.type, "session.update");
	const config = update.session as Record<string, unknown>;
	assert.deepEqual(config.modalities, ["text", "audio"]);
	assert.equal(config.input_audio_format, "pcm16");
	// StepFun's server VAD is what closes a turn; without it no transcript arrives.
	assert.deepEqual(config.turn_detection, {
		type: "server_vad",
		prefix_padding_ms: 500,
		silence_duration_ms: 450,
		energy_awakeness_threshold: 2500,
	});
	assert.ok(typeof update.event_id === "string", "every outbound message carries an event_id");
	assert.deepEqual(
		events.map((event) => event.type),
		["status", "status"],
	);
	assert.equal((events[0] as { status: string }).status, "connecting");
	assert.equal((events[1] as { status: string }).status, "listening");
	assert.ok(session.sessionId);
	relay.stop();
});

test("a session error during the handshake fails the start", async () => {
	const { factory, sockets } = fakeFactory();
	const relay = relayWith(factory);
	const starting = relay.start();
	sockets[0].open();
	// A quota-style failure is not a model problem, so it is not retried on
	// the fallback model; the service's own words reach the caller.
	sockets[0].message({ type: "error", error: { message: "quota exceeded" } });
	await assert.rejects(starting, (error: unknown) => {
		assert.ok(error instanceof VoiceError);
		assert.equal(error.code, "unreachable");
		assert.match(error.message, /quota exceeded/);
		return true;
	});
	assert.equal(sockets.length, 1, "a non-model failure is not retried on another model");
});

test("a second start is rejected while a session runs", async () => {
	const { factory, sockets } = fakeFactory();
	const relay = relayWith(factory);
	await startSession(relay, sockets);
	await assert.rejects(relay.start(), (error: unknown) => error instanceof VoiceError && error.status === 409);
	relay.stop();
});

test("start without a credential answers 503 with the no-credential code", async () => {
	const { factory } = fakeFactory();
	await assert.rejects(relayWithoutCredential(factory).start(), (error: unknown) => {
		assert.ok(error instanceof VoiceError);
		assert.equal(error.status, 503);
		assert.equal(error.code, "no-credential");
		return true;
	});
});

test("the platform channel retries once with the 2.5 model when the 3 model is unavailable", async () => {
	const { factory, sockets } = fakeFactory();
	const relay = relayWith(factory);
	const starting = relay.start();
	sockets[0].fail("Unexpected server response: 404");
	// The rejection lands in a microtask; let the relay open the fallback.
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(sockets.length, 2, "the fallback attempt opened a second socket");
	assert.equal(sockets[1].url, "wss://api.stepfun.com/v1/realtime?model=stepaudio-2.5-realtime");
	sockets[1].open();
	sockets[1].message({ type: "session.updated" });
	await starting;
	relay.stop();
});

test("an unreachable service fails the start instead of retrying every model", async () => {
	const { factory, sockets } = fakeFactory();
	const relay = relayWith(factory);
	const starting = relay.start();
	sockets[0].fail("connect ECONNREFUSED");
	await assert.rejects(starting, (error: unknown) => error instanceof VoiceError && error.code === "unreachable");
	assert.equal(sockets.length, 1, "a network failure is not a model problem");
});

test("audio chunks are forwarded verbatim and bounded", async () => {
	const { factory, sockets } = fakeFactory();
	const relay = relayWith(factory);
	await startSession(relay, sockets);

	relay.append(audioChunk);
	const appended = sockets[0].sentJson()[1];
	assert.equal(appended.type, "input_audio_buffer.append");
	assert.equal(appended.audio, audioChunk);

	// The limit is on the decoded bytes, so the base64 is ~4/3 of it.
	assert.throws(() => relay.append("x".repeat(MAX_VOICE_CHUNK_BYTES * 2)), (error: unknown) => error instanceof VoiceError && error.status === 413);
	assert.throws(() => relay.append(""), (error: unknown) => error instanceof VoiceError && error.status === 400);
	relay.stop();
});

test("append and stop outside a session are not found", async () => {
	const { factory } = fakeFactory();
	const relay = relayWith(factory);
	assert.throws(() => relay.append(audioChunk), (error: unknown) => error instanceof VoiceError && error.status === 404);
	// Stopping an idle relay is a no-op, not an error.
	relay.stop();
});

test("transcription deltas stream as partial and completed events, deduplicated by item", async () => {
	const { factory, sockets } = fakeFactory();
	const relay = relayWith(factory);
	const events: VoiceEvent[] = [];
	relay.subscribe((event) => events.push(event));
	await startSession(relay, sockets);
	const socket = sockets[0];

	socket.message({ type: "input_audio_buffer.speech_started" });
	socket.message({ type: "conversation.item.input_audio_transcription.delta", delta: "你好", item_id: "i1", content_index: 0 });
	socket.message({
		type: "conversation.item.input_audio_transcription.completed",
		transcript: "你好世界",
		item_id: "i1",
		content_index: 0,
	});
	// A replayed completion must not insert the text twice.
	socket.message({
		type: "conversation.item.input_audio_transcription.completed",
		transcript: "你好世界",
		item_id: "i1",
		content_index: 0,
	});
	// A different item of the same turn still counts.
	socket.message({
		type: "conversation.item.input_audio_transcription.completed",
		transcript: "第二条",
		item_id: "i1",
		content_index: 1,
	});
	// An empty completion carries no text.
	socket.message({ type: "conversation.item.input_audio_transcription.completed", transcript: "", item_id: "i2", content_index: 0 });
	// Unknown events are ignored.
	socket.message({ type: "session.created" });
	socket.message("not json");
	// The turn closes; a stop after this is immediate.
	socket.message({ type: "input_audio_buffer.speech_stopped" });

	const transcripts = events.filter((event) => event.type === "transcript");
	assert.deepEqual(transcripts, [
		{ type: "transcript", kind: "partial", text: "你好" },
		{ type: "transcript", kind: "final", text: "你好世界" },
		{ type: "transcript", kind: "final", text: "第二条" },
	]);
	relay.stop();
});

test("stopping with an open turn flushes silence and still delivers the final transcript", async () => {
	const { factory, sockets } = fakeFactory();
	const relay = new VoiceRelay({
		resolveCredential: () => testCredential,
		webSocket: factory,
		stopFlushMs: 50,
	});
	const events: VoiceEvent[] = [];
	relay.subscribe((event) => events.push(event));
	const socket = await startSession(relay, sockets);
	socket.message({ type: "input_audio_buffer.speech_started" });
	// The user clicks stop while the turn is still open: the host must not
	// close the socket yet, or the final transcript is cut off.
	relay.stop();
	assert.equal(socket.closed, false, "the socket stays open for the flush");
	const appended = socket.sentJson().filter((message) => message.type === "input_audio_buffer.append");
	assert.equal(appended.length, 15, "the host appends 1.5 s of silence itself");
	assert.equal(appended[0].audio, Buffer.alloc(4800).toString("base64"));

	// The service closes the turn on that silence and transcribes it.
	socket.message({ type: "input_audio_buffer.speech_stopped" });
	socket.message({
		type: "conversation.item.input_audio_transcription.completed",
		transcript: "尾句",
		item_id: "i2",
		content_index: 0,
	});
	assert.deepEqual(
		events.filter((event) => event.type === "transcript"),
		[{ type: "transcript", kind: "final", text: "尾句" }],
		"the transcript that arrives during the flush is still delivered",
	);

	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.ok(socket.closed, "the socket closes after the flush window");
	assert.equal((events.at(-1) as { status: string }).status, "stopped");
	// A new dictation may start right away.
	const restarting = relay.start();
	assert.equal(sockets.length, 2);
	sockets[1].open();
	sockets[1].message({ type: "session.updated" });
	await restarting;
	relay.stop();
});

test("a service error clears the session and emits one error event", async () => {
	const { factory, sockets } = fakeFactory();
	const relay = relayWith(factory);
	const events: VoiceEvent[] = [];
	relay.subscribe((event) => events.push(event));
	await startSession(relay, sockets);

	sockets[0].message({ type: "error", error: { message: "quota exceeded" } });
	const errors = events.filter((event) => event.type === "error");
	assert.equal(errors.length, 1);
	assert.equal((errors[0] as { message: string }).message, "quota exceeded");
	assert.equal((errors[0] as { code: string }).code, "service-error");
	// The session is gone: the client may start a new one, not append to a dead one.
	assert.throws(() => relay.append(audioChunk), (error: unknown) => error instanceof VoiceError && error.status === 404);
	assert.ok(sockets[0].closed, "the outbound socket was closed");
});

test("a failed transcription is reported once and clears the session", async () => {
	const { factory, sockets } = fakeFactory();
	const relay = relayWith(factory);
	const events: VoiceEvent[] = [];
	relay.subscribe((event) => events.push(event));
	await startSession(relay, sockets);

	sockets[0].message({
		type: "conversation.item.input_audio_transcription.failed",
		item_id: "i1",
		content_index: 0,
		error: { code: "transcription_error", message: "audio too quiet" },
	});
	const errors = events.filter((event) => event.type === "error");
	assert.equal(errors.length, 1);
	assert.equal((errors[0] as { message: string }).message, "audio too quiet");
	assert.equal((errors[0] as { code: string }).code, "transcription-failed");
	assert.throws(() => relay.append(audioChunk), (error: unknown) => error instanceof VoiceError && error.status === 404);
});

test("an outbound close after the session started is reported once", async () => {
	const { factory, sockets } = fakeFactory();
	const relay = relayWith(factory);
	const events: VoiceEvent[] = [];
	relay.subscribe((event) => events.push(event));
	await startSession(relay, sockets);

	sockets[0].serverClose(1006);
	sockets[0].serverClose(1006);
	const errors = events.filter((event) => event.type === "error");
	assert.equal(errors.length, 1);
	assert.equal((errors[0] as { code: string }).code, "service-closed");
});

test("stop closes the outbound socket and settles with a stopped status", async () => {
	const { factory, sockets } = fakeFactory();
	const relay = relayWith(factory);
	const events: VoiceEvent[] = [];
	relay.subscribe((event) => events.push(event));
	await startSession(relay, sockets);

	relay.stop();
	assert.ok(sockets[0].closed);
	assert.deepEqual(
		events.filter((event) => event.type === "status").map((event) => (event as { status: string }).status),
		["connecting", "listening", "stopped"],
	);
	assert.throws(() => relay.append(audioChunk), (error: unknown) => error instanceof VoiceError && error.status === 404);
});

test("stopAll drops the session without emitting", async () => {
	const { factory, sockets } = fakeFactory();
	const relay = relayWith(factory);
	const events: VoiceEvent[] = [];
	relay.subscribe((event) => events.push(event));
	await startSession(relay, sockets);

	relay.stopAll();
	assert.ok(sockets[0].closed);
	assert.equal(events.filter((event) => event.type === "status" || event.type === "error").length, 2);
});

test("credential resolution prefers the environment over auth.json and maps the channels", () => {
	const authPath = "/nonexistent-auth.json";
	const modelsPath = "/nonexistent-models.json";
	const emptyReaders = {
		readCredential: () => undefined,
		readProviders: () => ({}),
	};

	// 1. Environment key: the platform channel with the 3 model.
	assert.deepEqual(
		resolveVoiceCredential({
			env: { STEP_API_KEY: "env-key" },
			authPath,
			modelsPath,
			...emptyReaders,
		}),
		{ key: "env-key", keySource: "environment", channel: "platform", baseUrl: "https://api.stepfun.com/v1", model: "stepaudio-3-realtime-preview" },
	);
	// STEPFUN_API_KEY is the plugin's fallback spelling.
	assert.equal(resolveVoiceCredential({ env: { STEPFUN_API_KEY: "env-key" }, authPath, modelsPath, ...emptyReaders })?.key, "env-key");

	// 2. auth.json outranks the custom providers; the profile picks the channel.
	const stored = (providerId: string) =>
		providerId === "step"
			? { type: "api_key", key: "plan-key", profile: "step_plan" }
			: providerId === "mp"
				? { type: "api_key", key: "mp-key" }
				: undefined;
	const providers = () => ({
		mp: { baseUrl: "https://models-proxy.stepfun-inc.com", apiKey: "$STEPCODE_API_KEY", models: [{ id: "claude-opus-5.5" }] },
	});
	assert.deepEqual(
		resolveVoiceCredential({
			env: {},
			authPath,
			modelsPath,
			readCredential: stored,
			readProviders: providers,
		}),
		{
			key: "plan-key",
			keySource: "auth.json",
			channel: "step_plan",
			baseUrl: "https://api.stepfun.com/step_plan/v1",
			model: "stepaudio-2.5-realtime",
		},
	);

	// 3. An OAuth sign-in is a Step Plan login; the overseas profile moves the host.
	assert.equal(
		resolveVoiceCredential({
			env: {},
			authPath,
			modelsPath,
			readCredential: (providerId) => (providerId === "step" ? { type: "oauth", access: "oauth-token", profile: "step_plan_oversea" } : undefined),
			readProviders: () => ({}),
		})?.baseUrl,
		"https://api.stepfun.ai/step_plan/v1",
	);

	// 4. A key without a plan profile is an open-platform key.
	assert.deepEqual(
		resolveVoiceCredential({
			env: {},
			authPath,
			modelsPath,
			readCredential: (providerId) => (providerId === "step" ? { type: "api_key", key: "platform-key" } : undefined),
			readProviders: () => ({}),
		}),
		{
			key: "platform-key",
			keySource: "auth.json",
			channel: "platform",
			baseUrl: "https://api.stepfun.com/v1",
			model: "stepaudio-3-realtime-preview",
		},
	);
});

test("credential resolution falls back to a custom provider's key and declared realtime model", () => {
	const providers = () => ({
		mp: {
			baseUrl: "https://models-proxy.stepfun-inc.com",
			apiKey: "$STEPCODE_API_KEY",
			models: [{ id: "stepaudio-2.5-realtime" }],
		},
	});
	const credential = resolveVoiceCredential({
		env: { STEPCODE_API_KEY: "mp-key" },
		authPath: "/nonexistent-auth.json",
		modelsPath: "/nonexistent-models.json",
		readCredential: () => undefined,
		readProviders: providers,
	});
	assert.deepEqual(credential, {
		key: "mp-key",
		keySource: "provider",
		channel: "custom",
		baseUrl: "https://models-proxy.stepfun-inc.com",
		model: "stepaudio-2.5-realtime",
	});

	// No key anywhere: voice is unavailable rather than misconfigured.
	assert.equal(
		resolveVoiceCredential({
			env: {},
			authPath: "/nonexistent-auth.json",
			modelsPath: "/nonexistent-models.json",
			readCredential: () => undefined,
			readProviders: providers,
		}),
		undefined,
	);
});

test("environment overrides repoint the resolved channel", () => {
	const credential = resolveVoiceCredential({
		env: { STEP_API_KEY: "env-key", STEP_VOICE_BASE_URL: "https://example.invalid/v1", STEP_VOICE_REALTIME_MODEL: "custom-realtime" },
		authPath: "/nonexistent-auth.json",
		modelsPath: "/nonexistent-models.json",
		readCredential: () => undefined,
		readProviders: () => ({}),
	});
	assert.equal(credential?.baseUrl, "https://example.invalid/v1");
	assert.equal(credential?.model, "custom-realtime");
});

/** Mount `voiceRoute` the way `server.ts` dispatches it: parts after `voice`. */
function voiceServer(relay: VoiceRelay): { root: string; close: () => Promise<void> } {
	const server = createServer((request, response) => {
		const url = new URL(request.url || "/", "http://localhost");
		const parts = url.pathname.split("/").filter(Boolean);
		void voiceRoute(relay, parts.slice(1), request, response);
	});
	return {
		root: new Promise<string>((resolve) => {
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				resolve(`http://127.0.0.1:${address && typeof address !== "string" ? address.port : 0}`);
			});
		}),
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

test("the voice HTTP adapter answers status, start, audio, stop and rejects what it should", async () => {
	const { factory, sockets } = fakeFactory();
	const relay = relayWith(factory);
	const server = voiceServer(relay);
	const root = await server.root;
	try {
		const status = await fetch(`${root}/voice`);
		assert.equal(status.status, 200);
		assert.equal((await status.json()).available, true);

		// Audio without a session is not found, not a server fault.
		const orphan = await fetch(`${root}/voice/audio`, {
			method: "POST",
			body: JSON.stringify({ data: audioChunk }),
			headers: { "content-type": "application/json" },
		});
		assert.equal(orphan.status, 404);

		const starting = fetch(`${root}/voice/start`, { method: "POST" });
		// The handler opens the outbound socket when the request arrives.
		for (let n = 0; n < 100 && sockets.length === 0; n++) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(sockets.length, 1);
		sockets[0].open();
		sockets[0].message({ type: "session.updated" });
		const started = await starting;
		assert.equal(started.status, 200);
		assert.ok((await started.json()).sessionId);

		const oversized = await fetch(`${root}/voice/audio`, {
			method: "POST",
			body: JSON.stringify({ data: "x".repeat(800 * 1024) }),
			headers: { "content-type": "application/json" },
		});
		assert.equal(oversized.status, 413);
		assert.equal((await oversized.json()).code, "body-too-large");

		const bad = await fetch(`${root}/voice/audio`, { method: "POST", body: "{", headers: { "content-type": "application/json" } });
		assert.equal(bad.status, 400);

		assert.equal((await fetch(`${root}/voice/nope`)).status, 404);
		assert.equal((await fetch(`${root}/voice/events`, { method: "POST" })).status, 404);

		const stopped = await fetch(`${root}/voice/stop`, { method: "POST" });
		assert.equal(stopped.status, 200);
	} finally {
		await server.close();
		relay.stopAll();
	}
});

test("start without a credential answers 503 over HTTP", async () => {
	const { factory } = fakeFactory();
	const relay = relayWithoutCredential(factory);
	const server = voiceServer(relay);
	const root = await server.root;
	try {
		const started = await fetch(`${root}/voice/start`, { method: "POST" });
		assert.equal(started.status, 503);
		assert.equal((await started.json()).code, "no-credential");
	} finally {
		await server.close();
	}
});

test("the SSE stream delivers transcript events and unsubscribes on close", async () => {
	const { factory, sockets } = fakeFactory();
	const relay = relayWith(factory);
	const server = voiceServer(relay);
	const root = await server.root;
	try {
		const events = await fetch(`${root}/voice/events`);
		assert.equal(events.status, 200);
		assert.match(events.headers.get("content-type") ?? "", /text\/event-stream/);
		const reader = events.body?.getReader();
		assert.ok(reader);
		const decoder = new TextDecoder();

		const starting = relay.start();
		sockets[0].open();
		sockets[0].message({ type: "session.updated" });
		await starting;
		sockets[0].message({ type: "conversation.item.input_audio_transcription.completed", transcript: "流式转写", item_id: "i1", content_index: 0 });

		// Frames arrive in order (connecting, listening, transcript); read until the text lands.
		let seen = "";
		for (let n = 0; n < 20 && !seen.includes("流式转写"); n++) {
			const chunk = await reader.read();
			if (chunk.done) break;
			seen += decoder.decode(chunk.value, { stream: true });
		}
		assert.match(seen, /event: transcript/);
		assert.match(seen, /"kind":"final"/);
		assert.match(seen, /流式转写/);
		assert.match(seen, /event: status/);

		// A gone page releases the relay's listener: stop() must reach nobody.
		await reader.cancel();
		relay.stop();
	} finally {
		await server.close();
		relay.stopAll();
	}
});
