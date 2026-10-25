/**
 * Voice dictation relay: the host side of the composer's microphone button.
 *
 * The browser records the microphone and posts PCM16 chunks here; this relay
 * owns the single outbound realtime session to StepFun and normalises its
 * events into the SSE stream the client listens on. The model credential is
 * resolved on the host and never leaves it: the browser talks to this host
 * only, and the status route reports the source and channel, never the key.
 *
 * Design notes:
 * - Single session: the desktop app is single-user, so one dictation at a
 *   time; a second `start` answers 409 rather than stealing the first.
 * - Server VAD: the client only captures and chunks. Turn boundaries and
 *   transcription completion come from StepFun's realtime service.
 * - Deduplication: a `transcription.completed` event is keyed by
 *   `item_id` + `content_index`, so a replayed event cannot insert the same
 *   text into the prompt twice.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	getStepAuthPath,
	readModelsJsonProviders,
	readStoredCredential,
	resolveStepConfigRoot,
} from "@step-harness/coding-agent";

/** Which StepFun service a voice credential addresses (see the channel table). */
export type VoiceChannel = "step_plan" | "platform" | "custom";

/** Where the key came from; reported to the client, which shows guidance from it. */
export type VoiceKeySource = "environment" | "auth.json" | "provider";

/** A resolved voice credential. The key stays inside the host process. */
export interface VoiceCredential {
	readonly key: string;
	readonly keySource: VoiceKeySource;
	readonly channel: VoiceChannel;
	/** Realtime service base, e.g. `https://api.stepfun.com/step_plan/v1`. */
	readonly baseUrl: string;
	readonly model: string;
}

/** Why voice is unavailable; the client turns these into localised guidance. */
export type VoiceUnavailableReason = "no-credential";

/** What `GET /api/v1/voice/status` reports. No field can carry the key. */
export interface VoiceStatus {
	readonly available: boolean;
	readonly reason?: VoiceUnavailableReason;
	readonly channel?: VoiceChannel;
	readonly model?: string;
	readonly keySource?: VoiceKeySource;
}

/**
 * The subset of the built-in `WebSocket` (Node >= 22.19, verified on 22.22)
 * this relay drives. The host builds without DOM libs, so the global
 * constructor is untyped; the default factory below asserts it against this
 * structural shape. Tests inject a scripted fake instead.
 */
export interface VoiceWebSocket {
	send(data: string): void;
	close(): void;
	onopen: (() => void) | null;
	onmessage: ((event: { readonly data: string }) => void) | null;
	onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null;
	onerror: ((event: { readonly message?: string }) => void) | null;
}

export type VoiceWebSocketFactory = (
	url: string,
	options: { readonly headers: Record<string, string> },
) => VoiceWebSocket;

/** An operation the route layer answers with an HTTP status. */
export class VoiceError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(message: string, status: number, code: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

/** Session states the client renders; `idle` is also the settled state after an error. */
export type VoiceSessionStatus = "idle" | "connecting" | "listening" | "error" | "stopped";

export type VoiceEvent =
	| { readonly type: "status"; readonly status: VoiceSessionStatus }
	| { readonly type: "transcript"; readonly kind: "partial" | "final"; readonly text: string }
	| { readonly type: "error"; readonly message: string; readonly code: string };

export type VoiceListener = (event: VoiceEvent) => void;

/** Largest accepted audio chunk (base64-decoded); the client sends 100 ms slices. */
export const MAX_VOICE_CHUNK_BYTES = 512 * 1024;
/** One dictation may not run longer than this; the relay then closes the session. */
export const MAX_VOICE_SESSION_MS = 10 * 60 * 1000;
/** Total audio per session, so a stuck client cannot stream forever. */
export const MAX_VOICE_SESSION_BYTES = 64 * 1024 * 1024;
/** How long the realtime handshake may take before the attempt is abandoned. */
const VOICE_OPEN_TIMEOUT_MS = 10_000;

const STEP_PLAN_BASE = "https://api.stepfun.com/step_plan/v1";
const STEP_PLAN_OVERSEA_BASE = "https://api.stepfun.ai/step_plan/v1";
const PLATFORM_BASE = "https://api.stepfun.com/v1";
/** The realtime model both channels can run; the fallback when 3 is unavailable. */
const REALTIME_MODEL = "stepaudio-2.5-realtime";
/** The platform channel's default; it falls back to `REALTIME_MODEL` once on failure. */
const PLATFORM_REALTIME_MODEL = "stepaudio-3-realtime-preview";

/** Environment overrides, aligned with the terminal voice plugin. */
const ENV_BASE_URL = "STEP_VOICE_BASE_URL";
const ENV_MODEL = "STEP_VOICE_REALTIME_MODEL";

/** Credential resolution inputs, all overridable so tests never touch the real files. */
export interface VoiceCredentialOptions {
	readonly env?: Record<string, string | undefined>;
	readonly authPath?: string;
	readonly modelsPath?: string;
	/**
	 * One stored credential entry, as `auth.json` holds it: `type` plus the
	 * secret (`key` for an api key, `access` for OAuth) and the login
	 * `profile` recorded at sign-in. Defaults to the coding agent's reader,
	 * whose `Credential` shape is this JSON object.
	 */
	readonly readCredential?: (providerId: string, authPath: string) => Record<string, unknown> | undefined;
	/** Defaults to `readModelsJsonProviders` from the coding agent. */
	readonly readProviders?: (path: string) => Record<string, Record<string, unknown>>;
}

/** The `step` entry of `auth.json` as the relay needs it: secret plus profile. */
interface StepAuthEntry {
	readonly secret: string;
	readonly profile?: string;
	readonly oauth: boolean;
}

/**
 * Read the `step` entry of `auth.json` — the same file `step login` and the
 * web sign-in page write. Only the host ever sees the secret.
 */
function stepAuthEntry(
	authPath: string,
	readCredential: (providerId: string, authPath: string) => Record<string, unknown> | undefined,
): StepAuthEntry | undefined {
	const entry = readCredential("step", authPath);
	if (!entry) return undefined;
	const profile = typeof entry.profile === "string" && entry.profile.trim() ? entry.profile.trim() : undefined;
	if (entry.type === "oauth") {
		const access = typeof entry.access === "string" ? entry.access.trim() : "";
		return access ? { secret: access, profile, oauth: true } : undefined;
	}
	if (entry.type === "api_key") {
		const key = typeof entry.key === "string" ? entry.key.trim() : "";
		return key ? { secret: key, profile, oauth: false } : undefined;
	}
	return undefined;
}

function firstString(source: Record<string, unknown>, key: string): string | undefined {
	const value = source[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A realtime-capable model id a custom provider declares, if any. */
function declaredRealtimeModel(provider: Record<string, unknown>): string | undefined {
	const models = provider.models;
	if (!Array.isArray(models)) return undefined;
	for (const entry of models) {
		if (!entry || typeof entry !== "object") continue;
		const id =
			firstString(entry as Record<string, unknown>, "id") ?? firstString(entry as Record<string, unknown>, "model");
		if (id && /realtime|audio/i.test(id)) return id;
	}
	return undefined;
}

/**
 * A custom provider's key: the one stored for its id in `auth.json`, else the
 * declaration's `apiKey`, which may name an environment variable
 * (`$STEPCODE_API_KEY`, as an imported model proxy does).
 */
function customProviderKey(
	id: string,
	provider: Record<string, unknown>,
	env: Record<string, string | undefined>,
	authPath: string,
	readCredential: (providerId: string, authPath: string) => Record<string, unknown> | undefined,
): string | undefined {
	const stored = readCredential(id, authPath);
	const storedKey = stored && typeof stored.key === "string" ? stored.key.trim() : "";
	if (storedKey) return storedKey;
	const declared = firstString(provider, "apiKey");
	if (!declared) return undefined;
	if (!declared.startsWith("$")) return declared;
	const fromEnv = (env[declared.slice(1)] ?? "").trim();
	return fromEnv || undefined;
}

/**
 * Resolve the credential voice dictation uses, in priority order:
 *
 * 1. `STEP_API_KEY` / `STEPFUN_API_KEY` in the environment (a platform key).
 * 2. The stored `step` credential in `auth.json`; its login profile picks the
 *    channel (Step Plan vs the open platform).
 * 3. The first custom provider in `models.json` that has a stored key (an
 *    imported model proxy, for instance); whether it speaks the realtime
 *    protocol is a service-side fact the start attempt discovers.
 *
 * `STEP_VOICE_BASE_URL` / `STEP_VOICE_REALTIME_MODEL` override the resolved
 * channel, for trying another endpoint without editing configuration.
 */
export function resolveVoiceCredential(options: VoiceCredentialOptions = {}): VoiceCredential | undefined {
	const env = options.env ?? process.env;
	const authPath = options.authPath ?? getStepAuthPath(env);
	// The credential reader's `Credential` union is this JSON entry; the cast
	// keeps the option injectable with plain records in tests.
	const readCredential =
		options.readCredential ??
		((providerId: string, path: string) =>
			readStoredCredential(providerId, path) as Record<string, unknown> | undefined);
	const readProviders = options.readProviders ?? readModelsJsonProviders;

	const envKey = (env.STEP_API_KEY ?? "").trim() || (env.STEPFUN_API_KEY ?? "").trim();
	let credential: VoiceCredential | undefined;
	if (envKey) {
		credential = {
			key: envKey,
			keySource: "environment",
			channel: "platform",
			baseUrl: PLATFORM_BASE,
			model: PLATFORM_REALTIME_MODEL,
		};
	} else {
		const stored = stepAuthEntry(authPath, readCredential);
		if (stored) {
			// The recorded profile decides the region first; an OAuth sign-in
			// without one is a mainland Step Plan login, and an api key without
			// a plan profile is an open-platform key.
			if (stored.profile === "step_plan_oversea") {
				credential = {
					key: stored.secret,
					keySource: "auth.json",
					channel: "step_plan",
					baseUrl: STEP_PLAN_OVERSEA_BASE,
					model: REALTIME_MODEL,
				};
			} else if (stored.oauth || stored.profile === "step_plan") {
				credential = {
					key: stored.secret,
					keySource: "auth.json",
					channel: "step_plan",
					baseUrl: STEP_PLAN_BASE,
					model: REALTIME_MODEL,
				};
			} else {
				credential = {
					key: stored.secret,
					keySource: "auth.json",
					channel: "platform",
					baseUrl: PLATFORM_BASE,
					model: PLATFORM_REALTIME_MODEL,
				};
			}
		}
	}
	if (!credential) {
		const modelsPath = options.modelsPath ?? join(resolveStepConfigRoot(env), "models.json");
		for (const [id, provider] of Object.entries(readProviders(modelsPath))) {
			const baseUrl = firstString(provider, "baseUrl");
			const secret = customProviderKey(id, provider, env, authPath, readCredential);
			if (!baseUrl || !secret) continue;
			credential = {
				key: secret,
				keySource: "provider",
				channel: "custom",
				baseUrl,
				model: declaredRealtimeModel(provider) ?? REALTIME_MODEL,
			};
			break;
		}
	}
	if (!credential) return undefined;
	const baseUrl = (env[ENV_BASE_URL] ?? "").trim() || credential.baseUrl;
	const model = (env[ENV_MODEL] ?? "").trim() || credential.model;
	return baseUrl === credential.baseUrl && model === credential.model ? credential : { ...credential, baseUrl, model };
}

/** The realtime URL for a channel; `http(s)` becomes `ws(s)`. */
function realtimeUrl(baseUrl: string, model: string): string {
	const wsBase = baseUrl.replace(/^http/i, "ws");
	return `${wsBase.replace(/\/+$/, "")}/realtime?model=${encodeURIComponent(model)}`;
}

/**
 * The session configuration, replicated from the StepFun-Voice plugin's
 * verified client (`src/stepfun.mjs`, protocol source: platform.stepfun.com
 * realtime docs). Two details matter more than the rest:
 *
 * - `turn_detection` is what makes the service close a turn: without it the
 *   buffer is never committed and no transcription ever arrives. StepFun's
 *   server VAD uses its own `energy_awakeness_threshold` field, so the
 *   OpenAI-shaped config is not enough.
 * - `modalities` includes audio because the input transcription is delivered
 *   inside the response lifecycle; the relay ignores the model's audio reply.
 *
 * The instructions and voice belong to that reply, which the composer never
 * plays; they are kept verbatim because the payload above is the one proven
 * against the live service (verified 2026-10-25 with real speech).
 */
const REALTIME_INSTRUCTIONS =
	"这是语音直通 Step Code 的会话：用户的语音会被转写并直接交给 Step Code 执行。你可以用简短口语化的中文语音回应，例如确认收到、澄清追问或轻量提示，但不要自己完成编码任务，不要调用工具，不要编造 Step Code 的执行结果；复杂的回答交给 Step Code。";

function sessionUpdateMessage(): string {
	return JSON.stringify({
		event_id: randomUUID(),
		type: "session.update",
		session: {
			modalities: ["text", "audio"],
			instructions: REALTIME_INSTRUCTIONS,
			voice: "linjiajiejie",
			input_audio_format: "pcm16",
			output_audio_format: "pcm16",
			turn_detection: {
				type: "server_vad",
				prefix_padding_ms: 500,
				silence_duration_ms: 450,
				energy_awakeness_threshold: 2500,
			},
			tools: [],
		},
	});
}

function appendAudioMessage(base64: string): string {
	return JSON.stringify({ event_id: randomUUID(), type: "input_audio_buffer.append", audio: base64 });
}

/**
 * Support log for the desktop host's `web-server.log`: which channel a session
 * used, how much audio flowed, and which realtime events arrived. Never the
 * credential, and transcript text is reduced to its length — the composer is
 * where the user reads what they said.
 */
function log(line: string): void {
	console.log(`[voice] ${line}`);
}

/** Text of a realtime event field, tolerating the documented snake_case names. */
function eventText(event: Record<string, unknown>, key: string): string {
	const value = event[key];
	return typeof value === "string" ? value : "";
}

function eventNumber(event: Record<string, unknown>, key: string): number {
	const value = event[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

interface ActiveVoiceSession {
	readonly id: string;
	readonly socket: VoiceWebSocket;
	readonly startedAt: number;
	readonly seen: Set<string>;
	bytes: number;
	chunks: number;
	/** True between `speech_started` and `speech_stopped`: a turn is open. */
	speaking: boolean;
	/** Set once a stop was requested; the flush then owns the socket. */
	stopping: boolean;
	settled: boolean;
}

/** The built-in `WebSocket`, asserted against the structural interface above. */
const builtinWebSocket: VoiceWebSocketFactory = (url, options) => {
	const webSocket = (
		globalThis as { WebSocket?: new (url: string, options?: { headers?: Record<string, string> }) => VoiceWebSocket }
	).WebSocket;
	if (!webSocket) throw new VoiceError("This Node runtime has no built-in WebSocket", 501, "unsupported-runtime");
	return new webSocket(url, { headers: options.headers });
};

export interface VoiceRelayOptions {
	/** Defaults to {@link resolveVoiceCredential} against this process's environment. */
	readonly resolveCredential?: () => VoiceCredential | undefined;
	/** Defaults to the built-in `WebSocket`; tests inject a scripted fake. */
	readonly webSocket?: VoiceWebSocketFactory;
	readonly env?: Record<string, string | undefined>;
	readonly authPath?: string;
	readonly modelsPath?: string;
	/** Injectable clock for tests. */
	readonly now?: () => number;
	/**
	 * How long a stop keeps the session open to let an open turn finish:
	 * the host appends silence, the server VAD closes the turn and the final
	 * transcript arrives. Overridable so tests do not wait in real time.
	 */
	readonly stopFlushMs?: number;
}

/** Silence appended after a stop: 100 ms of PCM16 zeros at 24 kHz. */
const SILENCE_CHUNK = Buffer.alloc(4800).toString("base64");

/**
 * Owns the one outbound realtime session and fans its events out to SSE
 * listeners. The route layer (voice-routes.ts) is a thin HTTP shell around
 * this class; all protocol knowledge stays here.
 */
export class VoiceRelay {
	private readonly resolveCredential: () => VoiceCredential | undefined;
	private readonly webSocket: VoiceWebSocketFactory;
	private readonly now: () => number;
	private readonly stopFlushMs: number;
	private readonly listeners = new Set<VoiceListener>();
	private session: ActiveVoiceSession | undefined;
	/** A stopped session inside its flush window: still forwarding, not startable. */
	private flushing: ActiveVoiceSession | undefined;

	constructor(options: VoiceRelayOptions = {}) {
		this.resolveCredential =
			options.resolveCredential ??
			(() =>
				resolveVoiceCredential({
					...(options.env ? { env: options.env } : {}),
					...(options.authPath ? { authPath: options.authPath } : {}),
					...(options.modelsPath ? { modelsPath: options.modelsPath } : {}),
				}));
		this.webSocket = options.webSocket ?? builtinWebSocket;
		this.now = options.now ?? Date.now;
		this.stopFlushMs = options.stopFlushMs ?? 2500;
	}

	/** Availability snapshot for the composer's button; never includes the key. */
	status(): VoiceStatus {
		const credential = this.resolveCredential();
		if (!credential) return { available: false, reason: "no-credential" };
		return { available: true, channel: credential.channel, model: credential.model, keySource: credential.keySource };
	}

	/** Register an event sink (the SSE route). Returns the unsubscribe. */
	subscribe(listener: VoiceListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Open the outbound realtime session and resolve once it is live. The
	 * platform channel retries once with the 2.5 model when the 3 model is
	 * unavailable on this account.
	 */
	async start(): Promise<{ sessionId: string }> {
		if (this.session) throw new VoiceError("A voice session is already running", 409, "session-active");
		const credential = this.resolveCredential();
		if (!credential) {
			throw new VoiceError(
				"No model credential is configured; run `step login` or add a Step API key first",
				503,
				"no-credential",
			);
		}
		const models =
			credential.model === PLATFORM_REALTIME_MODEL ? [PLATFORM_REALTIME_MODEL, REALTIME_MODEL] : [credential.model];
		let lastError: VoiceError | undefined;
		for (const model of models) {
			try {
				return await this.openSession(credential, model);
			} catch (caught) {
				lastError = caught instanceof VoiceError ? caught : new VoiceError(String(caught), 502, "unreachable");
				// Only a missing model justifies the next candidate; an unreachable
				// service or a rejected key fails the same way for every model.
				if (lastError.code !== "model-unavailable") break;
			}
		}
		throw lastError ?? new VoiceError("Voice service could not be reached", 502, "unreachable");
	}

	/** Forward one base64 PCM16 chunk to the active (or flushing) session. */
	append(base64: unknown): void {
		// A chunk already in flight when the user stops still belongs to the
		// session; the flush window accepts it rather than failing the client.
		const session = this.session ?? this.flushing;
		if (!session) throw new VoiceError("No active voice session", 404, "no-session");
		if (typeof base64 !== "string" || !base64) throw new VoiceError("Audio data is required", 400, "invalid-audio");
		const bytes = Math.floor((base64.length * 3) / 4);
		if (bytes > MAX_VOICE_CHUNK_BYTES) {
			throw new VoiceError(`Audio chunk exceeds the ${MAX_VOICE_CHUNK_BYTES} byte limit`, 413, "chunk-too-large");
		}
		const elapsed = this.now() - session.startedAt;
		if (elapsed > MAX_VOICE_SESSION_MS || session.bytes + bytes > MAX_VOICE_SESSION_BYTES) {
			this.failSession(session, "Voice session exceeded its size or duration limit", "session-limit");
			throw new VoiceError("Voice session exceeded its size or duration limit", 413, "session-limit");
		}
		session.bytes += bytes;
		session.chunks += 1;
		// One line per second of audio keeps the log readable.
		if (session.chunks === 1 || session.chunks % 100 === 0) {
			log(`session ${session.id} forwarded ${session.chunks} chunks (${session.bytes} bytes)`);
		}
		session.socket.send(appendAudioMessage(base64));
	}

	/**
	 * End the session. When a turn is still open — the user clicked stop while
	 * (or right after) speaking — closing at once would cut the final
	 * transcript off: the server VAD needs trailing silence to commit the
	 * buffer. So the host appends the silence itself and keeps the socket open
	 * for a bounded window, letting the last transcript land before the close.
	 * With no open turn the close is immediate.
	 */
	stop(): void {
		const session = this.session;
		if (!session) return;
		this.session = undefined;
		session.stopping = true;
		if (!session.speaking) {
			this.closeSession(session, "idle");
			return;
		}
		log(`session ${session.id} stopping with an open turn; flushing silence`);
		this.flushing = session;
		for (let index = 0; index < 15; index++) session.socket.send(appendAudioMessage(SILENCE_CHUNK));
		setTimeout(() => this.closeSession(session, "flushed"), this.stopFlushMs);
	}

	/** Shutdown hook: drop the outbound connection without emitting. */
	stopAll(): void {
		const session = this.session ?? this.flushing;
		if (!session) return;
		this.session = undefined;
		this.flushing = undefined;
		session.stopping = true;
		try {
			session.socket.close();
		} catch {
			// Same as stop(): the process is going away.
		}
	}

	/** Close the socket and settle the session; `stage` only feeds the log. */
	private closeSession(session: ActiveVoiceSession, stage: string): void {
		if (session.settled) return;
		session.settled = true;
		if (this.flushing === session) this.flushing = undefined;
		try {
			session.socket.close();
		} catch {
			// A socket that is already gone needs no close.
		}
		log(`session ${session.id} closed (${stage}) after ${session.chunks} chunks / ${session.bytes} bytes`);
		this.emit({ type: "status", status: "stopped" });
	}

	private async openSession(credential: VoiceCredential, model: string): Promise<{ sessionId: string }> {
		const id = randomUUID();
		this.emit({ type: "status", status: "connecting" });
		const socket = this.webSocket(realtimeUrl(credential.baseUrl, model), {
			headers: { Authorization: `Bearer ${credential.key}` },
		});
		const session: ActiveVoiceSession = {
			id,
			socket,
			startedAt: this.now(),
			seen: new Set(),
			bytes: 0,
			chunks: 0,
			speaking: false,
			stopping: false,
			settled: false,
		};
		log(`session ${id} starting on ${credential.channel} channel, model ${model}`);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				reject(new VoiceError("Voice service did not respond", 502, "unreachable"));
			}, VOICE_OPEN_TIMEOUT_MS);
			const cleanup = () => {
				clearTimeout(timer);
				socket.onopen = null;
				socket.onerror = null;
				socket.onclose = null;
				socket.onmessage = null;
			};
			socket.onopen = () => {
				// The configuration goes out immediately; audio may only flow
				// once the service confirms it with `session.updated` (the
				// plugin's client enforces the same order, and the service
				// rejects audio sent before the session is configured).
				socket.send(sessionUpdateMessage());
			};
			socket.onmessage = (event) => {
				let message: unknown;
				try {
					message = JSON.parse(event.data);
				} catch {
					return;
				}
				if (!message || typeof message !== "object") return;
				const type = (message as Record<string, unknown>).type;
				if (type === "session.updated") {
					cleanup();
					log(`session ${id} configured`);
					resolve();
					return;
				}
				if (type === "error") {
					cleanup();
					const error = (message as Record<string, unknown>).error;
					const reason =
						error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string"
							? ((error as Record<string, unknown>).message as string)
							: "Voice service rejected the session";
					reject(
						new VoiceError(
							reason,
							502,
							/40[34]|not found|unsupported|invalid/i.test(reason) ? "model-unavailable" : "unreachable",
						),
					);
				}
			};
			socket.onerror = (event) => {
				cleanup();
				const message = event.message ?? "Voice service connection failed";
				// A rejected model surfaces as an HTTP status in the handshake error.
				reject(
					new VoiceError(
						message,
						502,
						/40[34]|not found|unsupported/i.test(message) ? "model-unavailable" : "unreachable",
					),
				);
			};
			socket.onclose = (event) => {
				cleanup();
				reject(
					new VoiceError(
						`Voice service closed the connection (${event.code})`,
						502,
						event.code === 1006 ? "unreachable" : "model-unavailable",
					),
				);
			};
		}).catch((caught: unknown) => {
			try {
				socket.close();
			} catch {
				// Already closed.
			}
			throw caught;
		});
		this.session = session;
		socket.onmessage = (event) => this.handleMessage(session, event.data);
		socket.onclose = (event) => this.handleClose(session, event);
		socket.onerror = (event) => this.handleError(session, event.message ?? "Voice service error");
		this.emit({ type: "status", status: "listening" });
		return { sessionId: id };
	}

	/** Normalise one realtime event into the SSE vocabulary. */
	private handleMessage(session: ActiveVoiceSession, data: string): void {
		// A stopping session keeps its handlers: the flush window is exactly
		// when the final transcript arrives.
		if (this.session !== session && !session.stopping) return;
		let event: unknown;
		try {
			event = JSON.parse(data);
		} catch {
			return;
		}
		if (!event || typeof event !== "object") return;
		const record = event as Record<string, unknown>;
		if (typeof record.type === "string") log(`session ${session.id} event ${record.type}`);
		switch (record.type) {
			case "input_audio_buffer.speech_started":
				session.speaking = true;
				this.emit({ type: "status", status: "listening" });
				return;
			case "input_audio_buffer.speech_stopped":
				session.speaking = false;
				return;
			case "conversation.item.input_audio_transcription.delta": {
				// The service sends no input-side deltas today (only the final
				// transcript); the handler stays for forward compatibility.
				const text = eventText(record, "delta");
				if (text) this.emit({ type: "transcript", kind: "partial", text });
				return;
			}
			case "conversation.item.input_audio_transcription.completed": {
				// The same completion can arrive twice (reconnect, replay); the
				// prompt must not receive the text a second time.
				const key = `${eventText(record, "item_id")}\u0000${eventNumber(record, "content_index")}`;
				if (session.seen.has(key)) return;
				session.seen.add(key);
				const text = eventText(record, "transcript");
				if (text) {
					log(`session ${session.id} final transcript, ${text.length} chars`);
					this.emit({ type: "transcript", kind: "final", text });
				}
				return;
			}
			case "conversation.item.input_audio_transcription.failed": {
				const error = record.error;
				const reason =
					error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string"
						? ((error as Record<string, unknown>).message as string)
						: "Voice service failed to transcribe";
				this.failSession(session, reason, "transcription-failed");
				return;
			}
			case "error": {
				const error = record.error;
				const message =
					error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string"
						? ((error as Record<string, unknown>).message as string)
						: "Voice service reported an error";
				this.failSession(session, message, "service-error");
				return;
			}
			default:
				// session.created, committed buffers and friends carry no UI state.
				return;
		}
	}

	private handleClose(session: ActiveVoiceSession, event: { readonly code: number; readonly reason: string }): void {
		if (session.settled) return;
		if (this.session !== session && !session.stopping) return;
		this.failSession(session, `Voice service closed the connection (${event.code})`, "service-closed");
	}

	private handleError(session: ActiveVoiceSession, message: string): void {
		if (session.settled) return;
		if (this.session !== session && !session.stopping) return;
		this.failSession(session, message, "service-error");
	}

	/** Drop the session after a service-side failure; the client may retry once. */
	private failSession(session: ActiveVoiceSession, message: string, code: string): void {
		if (this.session === session) this.session = undefined;
		if (this.flushing === session) this.flushing = undefined;
		session.settled = true;
		try {
			session.socket.close();
		} catch {
			// Already closed.
		}
		log(`session ${session.id} failed: ${code} ${message}`);
		this.emit({ type: "error", message, code });
	}

	private emit(event: VoiceEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}
}
