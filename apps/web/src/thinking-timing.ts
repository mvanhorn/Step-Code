import type { AgentSessionEvent, SessionEntry } from "@step-harness/coding-agent";

export const THINKING_TIMING_TYPE = "stepcode-web.thinking-timing";

export interface ThinkingTiming {
	readonly startedAt: number;
	readonly endedAt?: number;
}

export type ThinkingTimings = Readonly<Record<string, ThinkingTiming>>;

interface ThinkingObservation {
	readonly version: 1;
	readonly messageTimestamp: number;
	readonly thinkingTimings: ThinkingTimings;
}

/** Validate host-owned metadata, never provider content or inferred message durations. */
export function readThinkingObservation(value: unknown): ThinkingObservation | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (
		record.version !== 1 ||
		typeof record.messageTimestamp !== "number" ||
		!Number.isFinite(record.messageTimestamp) ||
		!record.thinkingTimings ||
		typeof record.thinkingTimings !== "object" ||
		Array.isArray(record.thinkingTimings)
	)
		return undefined;
	const timings: Record<string, ThinkingTiming> = {};
	for (const [key, value] of Object.entries(record.thinkingTimings)) {
		if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) > 10000 || !value || typeof value !== "object") return undefined;
		const timing = value as Record<string, unknown>;
		if (
			typeof timing.startedAt !== "number" ||
			!Number.isFinite(timing.startedAt) ||
			typeof timing.endedAt !== "number" ||
			!Number.isFinite(timing.endedAt) ||
			timing.endedAt < timing.startedAt
		)
			return undefined;
		timings[key] = { startedAt: timing.startedAt, endedAt: timing.endedAt };
	}
	return { version: 1, messageTimestamp: record.messageTimestamp, thinkingTimings: timings };
}

export function savedThinkingTimings(entries: readonly SessionEntry[]): ReadonlyMap<number, ThinkingTimings> {
	const result = new Map<number, ThinkingTimings>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== THINKING_TIMING_TYPE) continue;
		const observation = readThinkingObservation(entry.data);
		if (observation) result.set(observation.messageTimestamp, observation.thinkingTimings);
	}
	return result;
}

/** One observer per bound session; clocks start only on actual thinking stream events. */
export class ThinkingClock {
	private messageTimestamp?: number;
	private timings: Record<string, ThinkingTiming> = {};
	private saved = false;

	observe(event: AgentSessionEvent, now = Date.now()): ThinkingTimings | undefined {
		if (
			(event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
			event.message.role === "assistant"
		) {
			if (event.message.timestamp !== this.messageTimestamp) {
				this.messageTimestamp = event.message.timestamp;
				this.timings = {};
				this.saved = false;
			}
			if (event.type === "message_update") {
				const delta = event.assistantMessageEvent;
				if ("contentIndex" in delta) {
					const index = delta.contentIndex;
					if (Number.isInteger(index) && index >= 0 && index <= 10000) {
						if (delta.type === "thinking_start" || delta.type === "thinking_delta") {
							this.stop(now, index);
							this.timings[index] ??= { startedAt: now };
						} else if (delta.type === "thinking_end") {
							const timing = this.timings[index];
							if (timing && timing.endedAt === undefined)
								this.timings[index] = { ...timing, endedAt: Math.max(timing.startedAt, now) };
						} else if (delta.type.startsWith("text_") || delta.type.startsWith("toolcall_")) {
							this.stop(now);
						}
					}
				}
			}
			if (event.type === "message_end") this.stop(now);
			return { ...this.timings };
		}
		if (event.type === "tool_execution_start" || event.type === "agent_end" || event.type === "agent_settled") {
			this.stop(now);
			return { ...this.timings };
		}
		return undefined;
	}

	private stop(now: number, except?: number): void {
		for (const [index, timing] of Object.entries(this.timings)) {
			if (Number(index) !== except && timing.endedAt === undefined)
				this.timings[index] = { ...timing, endedAt: Math.max(timing.startedAt, now) };
		}
	}

	/** A single metadata entry per message, only after every observed block has stopped. */
	completed(): ThinkingObservation | undefined {
		if (
			this.saved ||
			this.messageTimestamp === undefined ||
			!Object.keys(this.timings).length ||
			Object.values(this.timings).some((timing) => timing.endedAt === undefined)
		)
			return undefined;
		this.saved = true;
		return { version: 1, messageTimestamp: this.messageTimestamp, thinkingTimings: { ...this.timings } };
	}
}
