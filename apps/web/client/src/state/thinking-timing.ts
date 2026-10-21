import type { ThinkingTiming, ThinkingTimings } from "./types";

/** Timing crosses HTTP/SSE independently of the provider message. */
export function readThinkingTimings(value: unknown, completed = false): ThinkingTimings | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const result: Record<string, ThinkingTiming> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) > 10000 || !raw || typeof raw !== "object") return undefined;
		const timing = raw as Record<string, unknown>;
		if (
			typeof timing.startedAt !== "number" ||
			!Number.isFinite(timing.startedAt) ||
			(completed && timing.endedAt === undefined) ||
			(timing.endedAt !== undefined &&
				(typeof timing.endedAt !== "number" ||
					!Number.isFinite(timing.endedAt) ||
					timing.endedAt < timing.startedAt))
		)
			return undefined;
		result[key] = {
			startedAt: timing.startedAt,
			...(typeof timing.endedAt === "number" ? { endedAt: timing.endedAt } : {}),
		};
	}
	return result;
}

/** Same compact hours/minutes/seconds formatting as DFSC. */
export function thinkingElapsed(timing: ThinkingTiming, now: number): string {
	const seconds = Math.floor(Math.max(0, (timing.endedAt ?? now) - timing.startedAt) / 1000);
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	return `${hours ? `${hours}h` : ""}${hours || minutes ? `${minutes}m` : ""}${seconds % 60}s`;
}
