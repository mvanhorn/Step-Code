/**
 * Voice dictation: capture the microphone, stream PCM16 to the host relay and
 * land the transcript in the composer.
 *
 * The host owns the realtime session (see `apps/web/src/voice.ts`); this
 * module owns everything the browser side needs around it:
 *
 * - `GET /api/v1/voice` once, for the button's availability and channel;
 * - `POST /api/v1/voice/start` before capture, `POST /stop` after;
 * - `getUserMedia` + an `AudioWorklet` that emits 100 ms PCM16 chunks, each
 *   `POST`ed to `/api/v1/voice/audio`;
 * - an `EventSource` on `/api/v1/voice/events` for status, partial and final
 *   transcripts.
 *
 * Nothing here keeps state beyond one recording: a second `start` while one
 * runs is refused by the host, and the controller refuses it locally first.
 */

import { api, errorMessage } from "../../lib/api";
import type { VoiceEvent, VoiceStatus } from "../../state/types";

const ROOT = "/api/v1/voice";

/** The composer's sample rate expectation (24 kHz, like the terminal plugin). */
const CAPTURE_SAMPLE_RATE = 24000;

/**
 * The capture worklet, served from the client's static directory (Vite
 * `public/`). A stable absolute URL on purpose: `addModule` must load a real
 * module file, and an inlined data URL is not something to rely on.
 */
const CAPTURE_WORKLET_URL = "/voice-capture-worklet.js";

/** The worklet's message: one base64 PCM16 chunk, field named like the host's audio body. */
interface CaptureChunk {
	readonly data?: string;
	/** Live input level 0..1 for the recording waveform; rides with `data`. */
	readonly level?: number;
	/** Set when the worklet's own processing failed; it stops itself after. */
	readonly error?: string;
}

/**
 * How long the event stream outlives a stop, waiting for the host's flush to
 * finish. The host's own window is shorter; this only guards a lost `stopped`.
 */
const STOP_FLUSH_TIMEOUT_MS = 6000;

/**
 * What the button shows; `error` settles back to `idle` after the toast.
 * `transcribing` is the pause between stopping the microphone and the final
 * transcript landing: the service needs a moment of trailing silence.
 */
export type VoicePhase = "idle" | "connecting" | "listening" | "transcribing";

export interface VoiceHandlers {
	/** Phase changes for the button (connecting spinner, listening pulse). */
	readonly onPhase: (phase: VoicePhase) => void;
	/** Partial transcript, shown in the button's tooltip. */
	readonly onPartial: (text: string) => void;
	/** Live input level 0..1, about ten times a second while listening. */
	readonly onLevel?: (level: number) => void;
	/** Final transcript: the caller inserts it into the composer. */
	readonly onFinal: (text: string) => void;
	/** A failure with a localisable reason code; the caller shows the toast. */
	readonly onError: (code: string, reason: string) => void;
}

/** Availability snapshot, fetched once when the composer mounts. */
export function voiceStatus(signal?: AbortSignal): Promise<VoiceStatus> {
	return api<VoiceStatus>(ROOT, { signal });
}

/**
 * The stop function of the recording that is live, so the shell's Escape
 * chain can end it without the feature reaching into component state.
 * `requestVoiceStop` is a no-op when nothing is recording.
 */
let activeStop: (() => Promise<void>) | undefined;

export function setVoiceStopHook(stop: (() => Promise<void>) | undefined): void {
	activeStop = stop;
}

/** Whether a dictation is live, so the shell's Escape chain can end it. */
export function voiceRecording(): boolean {
	return activeStop !== undefined;
}

export function requestVoiceStop(): void {
	void activeStop?.();
}

/**
 * One dictation session: microphone in, transcript out. A failed chunk is
 * retried once and then fails the whole recording, because a gap in the
 * audio is worse than stopping and letting the user start again.
 *
 * Stopping is two-phase on purpose: the host needs a moment to let the last
 * turn finish (the service commits on trailing silence), so the event stream
 * stays open until the host reports `stopped` — the final transcript can
 * arrive after the button already returned to idle.
 */
export class VoiceRecorder {
	private readonly handlers: VoiceHandlers;
	private stream: MediaStream | undefined;
	private context: AudioContext | undefined;
	private worklet: AudioWorkletNode | undefined;
	private source: MediaStreamAudioSourceNode | undefined;
	private events: EventSource | undefined;
	private stopping = false;
	/** Set by a discarded stop: a late transcript must not reach the composer. */
	private discarded = false;
	/** Safety net: never keep the stream open longer than this after a stop. */
	private stopTimeout: ReturnType<typeof setTimeout> | undefined;

	constructor(handlers: VoiceHandlers) {
		this.handlers = handlers;
	}

	get active(): boolean {
		return this.stream !== undefined;
	}

	async start(): Promise<void> {
		if (this.active) return;
		this.discarded = false;
		this.handlers.onPhase("connecting");
		try {
			await api(`${ROOT}/start`, { method: "POST" });
			await this.openMicrophone();
			this.openEvents();
			this.handlers.onPhase("listening");
		} catch (error) {
			await this.teardown();
			this.handlers.onError(errorCode(error), errorMessage(error));
			this.handlers.onPhase("idle");
		}
	}

	/**
	 * Stop recording. Default: the microphone drops at once, the button shows
	 * the transcribing pause, and the final transcript still lands — the host
	 * appends the trailing silence itself and keeps the session open for it.
	 * `discard` (the cancel action and Escape) instead drops everything the
	 * service is about to transcribe and returns to idle immediately.
	 */
	async stop(options: { discard?: boolean } = {}): Promise<void> {
		if (!this.active || this.stopping) return;
		this.stopping = true;
		// The microphone stops here in both paths; only the wait afterwards
		// differs.
		for (const track of this.stream?.getTracks() ?? []) track.stop();
		this.stream = undefined;
		this.worklet?.port.close();
		this.worklet?.disconnect();
		this.worklet = undefined;
		this.source?.disconnect();
		this.source = undefined;
		if (this.context && this.context.state !== "closed") await this.context.close().catch(() => {});
		this.context = undefined;
		try {
			await api(`${ROOT}/stop`, { method: "POST" }).catch(() => {
				// The host may already have dropped the session; stopping is local anyway.
			});
		} finally {
			if (options.discard) {
				this.discarded = true;
				await this.teardown();
			} else {
				// The stream stays open for the flush; `stopped`, the final
				// transcript, or the timeout below tears it down.
				this.stopTimeout = setTimeout(() => void this.teardown(), STOP_FLUSH_TIMEOUT_MS);
				this.handlers.onPhase("transcribing");
			}
			this.stopping = false;
		}
	}

	private async openMicrophone(): Promise<void> {
		this.stream = await navigator.mediaDevices.getUserMedia({
			audio: { channelCount: 1, echoCancellation: true, autoGainControl: true, noiseSuppression: true },
		});
		this.context = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
		await this.context.audioWorklet.addModule(CAPTURE_WORKLET_URL);
		this.source = this.context.createMediaStreamSource(this.stream);
		this.worklet = new AudioWorkletNode(this.context, "capture-processor");
		// The worklet is pulled through a muted gain: processing must run, the
		// microphone must never play back into the speakers.
		const mute = this.context.createGain();
		mute.gain.value = 0;
		this.source.connect(this.worklet);
		this.worklet.connect(mute);
		mute.connect(this.context.destination);
		this.worklet.port.onmessage = (event: MessageEvent<CaptureChunk>) => {
			// The worklet reports its own failures instead of dying silently.
			if (event.data.error) {
				void this.fail("capture-failed", event.data.error);
				return;
			}
			if (typeof event.data.level === "number") this.handlers.onLevel?.(event.data.level);
			if (event.data.data) void this.sendChunk(event.data.data);
		};
	}

	private openEvents(): void {
		this.events = new EventSource(`${ROOT}/events`);
		this.events.addEventListener("status", (event) => {
			const payload = parseEvent(event);
			if (payload?.type !== "status") return;
			if (payload.status === "listening") this.handlers.onPhase("listening");
			// The host closed the session after its flush: the last transcript
			// has already been delivered, so the stream can go now.
			if (payload.status === "stopped") void this.teardown();
		});
		this.events.addEventListener("transcript", (event) => {
			const payload = parseEvent(event);
			if (payload?.type !== "transcript") return;
			if (payload.kind === "final") {
				// A discarded recording must not insert anything, even if the
				// service had already transcribed before the cancel landed.
				if (this.discarded) {
					void this.teardown();
					return;
				}
				this.handlers.onFinal(payload.text);
				// The final transcript is the last thing worth waiting for:
				// the host's `stopped` only confirms the socket went away.
				void this.teardown();
			} else {
				this.handlers.onPartial(payload.text);
			}
		});
		this.events.addEventListener("error", (event) => {
			const payload = parseEvent(event);
			if (payload?.type !== "error") return;
			void this.fail(payload.code, payload.message);
		});
	}

	private async sendChunk(data: string): Promise<void> {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await api(`${ROOT}/audio`, { method: "POST", body: JSON.stringify({ data }) });
				return;
			} catch (error) {
				if (attempt === 1) {
					await this.fail("chunk-failed", errorMessage(error));
					return;
				}
			}
		}
	}

	/** A service-side failure ends the recording; the user may start again. */
	private async fail(code: string, reason: string): Promise<void> {
		// A failure can also arrive during the stop flush, when the microphone
		// is already gone; the stream and the toast still matter then.
		if (!this.active && !this.events) return;
		await this.teardown();
		this.handlers.onError(code, reason);
		this.handlers.onPhase("idle");
	}

	/** Release the microphone, the audio graph and the event stream. */
	private async teardown(): Promise<void> {
		if (this.stopTimeout !== undefined) {
			clearTimeout(this.stopTimeout);
			this.stopTimeout = undefined;
		}
		this.events?.close();
		this.events = undefined;
		this.worklet?.port.close();
		this.worklet?.disconnect();
		this.worklet = undefined;
		this.source?.disconnect();
		this.source = undefined;
		for (const track of this.stream?.getTracks() ?? []) track.stop();
		this.stream = undefined;
		if (this.context && this.context.state !== "closed") await this.context.close().catch(() => {});
		this.context = undefined;
		this.handlers.onPartial("");
		this.handlers.onPhase("idle");
	}
}

function parseEvent(event: Event): VoiceEvent | undefined {
	if (!(event instanceof MessageEvent) || typeof event.data !== "string") return undefined;
	try {
		return JSON.parse(event.data) as VoiceEvent;
	} catch {
		return undefined;
	}
}

function errorCode(error: unknown): string {
	if (error && typeof error === "object" && "body" in error) {
		const code = (error as { body?: { code?: unknown } }).body?.code;
		if (typeof code === "string") return code;
	}
	// getUserMedia rejection: NotAllowedError is the denied-permission case.
	if (error instanceof DOMException && error.name === "NotAllowedError") return "mic-denied";
	return "failed";
}
