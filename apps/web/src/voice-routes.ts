import type { IncomingMessage, ServerResponse } from "node:http";
import { VoiceError, type VoiceRelay } from "./voice.ts";

/** Base64 of the largest accepted chunk, plus JSON envelope slack. */
const MAX_VOICE_BODY_BYTES = 768 * 1024;

function reply(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		bytes += buffer.length;
		if (bytes > MAX_VOICE_BODY_BYTES)
			throw new VoiceError("Voice request exceeds the size limit", 413, "body-too-large");
		chunks.push(buffer);
	}
	let value: unknown;
	try {
		value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
	} catch {
		throw new VoiceError("Invalid voice JSON", 400, "invalid-json");
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new VoiceError("Voice body must be an object", 400, "invalid-json");
	return value as Record<string, unknown>;
}

/**
 * `/api/v1/voice/*`: the composer's microphone button. The caller must perform
 * the Host's cookie and Origin checks before dispatch, exactly as for
 * `terminalRoute`.
 *
 * The relay owns the realtime session; this module only translates HTTP into
 * relay calls and one SSE stream. Audio goes up as JSON chunks and events come
 * down as SSE, reusing the terminal feature's shape rather than adding a
 * second websocket server to the Host.
 */
export async function voiceRoute(
	voice: VoiceRelay,
	parts: string[],
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	try {
		const method = request.method || "GET";
		if (parts.length === 0 && method === "GET") return reply(response, 200, voice.status());
		if (parts.length === 1 && parts[0] === "start" && method === "POST") {
			const session = await voice.start();
			return reply(response, 200, session);
		}
		if (parts.length === 1 && parts[0] === "audio" && method === "POST") {
			const input = await readBody(request);
			voice.append(input.data);
			return reply(response, 202, { ok: true });
		}
		if (parts.length === 1 && parts[0] === "stop" && method === "POST") {
			voice.stop();
			return reply(response, 200, { ok: true });
		}
		if (parts.length === 1 && parts[0] === "events" && method === "GET") return voiceEvents(voice, response);
		throw new VoiceError("Unknown voice route", 404, "not-found");
	} catch (error) {
		if (response.headersSent) {
			response.end();
			return;
		}
		const voiceError = error instanceof VoiceError ? error : undefined;
		reply(response, voiceError?.status ?? 500, {
			error: error instanceof Error ? error.message : String(error),
			...(voiceError ? { code: voiceError.code } : {}),
		});
	}
}

/**
 * SSE downlink: `status`, `transcript` and `error` events, one JSON object per
 * event, with the heartbeat and teardown the terminal stream uses. A gone page
 * must not keep the relay's listener set growing.
 */
function voiceEvents(voice: VoiceRelay, response: ServerResponse): void {
	response.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-store",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
	// Backpressure: transcript events are transient, so a dropped one is lost
	// text. Queue while the socket is congested and flush in order on drain.
	const pending: string[] = [];
	const flush = () => {
		while (pending.length > 0 && !response.writableNeedDrain) {
			const frame = pending.shift();
			if (frame === undefined) break;
			if (response.destroyed || response.writableEnded) return;
			response.write(frame);
		}
	};
	const unsubscribe = voice.subscribe((event) => {
		if (response.destroyed || response.writableEnded) return;
		pending.push(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
		flush();
	});
	response.on("drain", flush);
	const heartbeat = setInterval(() => {
		if (response.destroyed || response.writableEnded) return;
		if (response.writableNeedDrain) {
			// A congested client that never drains is gone; the heartbeat would
			// otherwise keep the connection (and the relay's listener) alive.
			response.destroy();
			return;
		}
		response.write(": heartbeat\n\n");
	}, 2000);
	response.once("close", () => {
		clearInterval(heartbeat);
		response.off("drain", flush);
		unsubscribe();
	});
}
