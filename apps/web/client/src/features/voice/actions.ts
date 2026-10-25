/**
 * Voice dictation: capture the microphone, stream PCM16 to the host relay and
 * land the transcript in the composer.
 *
 * The host owns the transcription (see `apps/web/src/voice.ts`); this module
 * owns everything the browser side needs around it:
 *
 * - `GET /api/v1/voice` once, for the button's availability;
 * - `POST /api/v1/voice/start` before capture, `POST /audio` per chunk,
 *   `POST /stop` to transcribe, `POST /cancel` to discard;
 * - `getUserMedia` + an `AudioWorklet` that emits 100 ms PCM16 chunks, each
 *   `POST`ed to the host, which buffers them and transcribes the whole
 *   recording on stop.
 *
 * Nothing here keeps state beyond one recording: a second `start` while one
 * runs is refused by the host, and the controller refuses it locally first.
 */

import { api, errorMessage } from "../../lib/api";
import type { VoiceStatus } from "../../state/types";

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
 * What the button shows; `error` settles back to `idle` after the toast.
 * `transcribing` is the pause between stopping the microphone and the host's
 * transcription reply landing.
 */
export type VoicePhase = "idle" | "connecting" | "listening" | "transcribing";

export interface VoiceHandlers {
	/** Phase changes for the button (connecting spinner, listening pulse). */
	readonly onPhase: (phase: VoicePhase) => void;
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
 * Stopping is a single request: the host transcribes the buffered recording
 * and answers with the text, so the button shows `transcribing` until the
 * reply lands. Cancelling answers immediately and discards the recording.
 */
export class VoiceRecorder {
	private readonly handlers: VoiceHandlers;
	private stream: MediaStream | undefined;
	private context: AudioContext | undefined;
	private worklet: AudioWorkletNode | undefined;
	private source: MediaStreamAudioSourceNode | undefined;
	private stopping = false;

	constructor(handlers: VoiceHandlers) {
		this.handlers = handlers;
	}

	get active(): boolean {
		return this.stream !== undefined;
	}

	async start(): Promise<void> {
		if (this.active) return;
		this.handlers.onPhase("connecting");
		try {
			await api(`${ROOT}/start`, { method: "POST" });
			await this.openMicrophone();
			this.handlers.onPhase("listening");
		} catch (error) {
			await this.teardown();
			this.handlers.onError(errorCode(error), errorMessage(error));
			this.handlers.onPhase("idle");
		}
	}

	/** Stop and transcribe: the reply carries the text for the composer. */
	async stop(): Promise<void> {
		if (!this.active || this.stopping) return;
		this.stopping = true;
		this.releaseMicrophone();
		this.handlers.onPhase("transcribing");
		try {
			const transcript = await api<{ text: string }>(`${ROOT}/stop`, { method: "POST" });
			if (transcript.text) this.handlers.onFinal(transcript.text);
			else this.handlers.onError("no-speech", "no-speech");
		} catch (error) {
			this.handlers.onError(errorCode(error), errorMessage(error));
		} finally {
			await this.teardown();
			this.stopping = false;
		}
	}

	/** Discard the recording: nothing is transcribed, nothing is inserted. */
	async cancel(): Promise<void> {
		if (!this.active || this.stopping) return;
		this.stopping = true;
		this.releaseMicrophone();
		try {
			await api(`${ROOT}/cancel`, { method: "POST" }).catch(() => {
				// The host may already have dropped the session; cancelling is local anyway.
			});
		} finally {
			await this.teardown();
			this.stopping = false;
		}
	}

	private releaseMicrophone(): void {
		for (const track of this.stream?.getTracks() ?? []) track.stop();
		this.stream = undefined;
		this.worklet?.port.close();
		this.worklet?.disconnect();
		this.worklet = undefined;
		this.source?.disconnect();
		this.source = undefined;
		if (this.context && this.context.state !== "closed") void this.context.close().catch(() => {});
		this.context = undefined;
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
		if (!this.active) return;
		this.releaseMicrophone();
		await this.teardown();
		this.handlers.onError(code, reason);
		this.handlers.onPhase("idle");
	}

	/** Release the microphone and the audio graph. */
	private async teardown(): Promise<void> {
		this.releaseMicrophone();
		this.handlers.onPhase("idle");
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
