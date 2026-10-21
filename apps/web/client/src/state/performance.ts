import type { SessionInspector } from "./types";

/** Ephemeral browser observations. Never restored from transcript timestamps. */
export interface PerformanceRun {
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly responseStartedAt?: number;
	readonly responseMs: number;
	readonly output: number;
}

export interface PerformanceEvent {
	readonly type: string;
	readonly message?: { readonly role?: string; readonly usage?: unknown };
}

/** Measure completed model responses, including thinking but excluding tools and retry backoff. */
export function observePerformance(
	run: PerformanceRun | null,
	event: PerformanceEvent,
	now: number,
): PerformanceRun | null {
	if (!Number.isFinite(now)) return run;
	if (event.type === "agent_start") {
		return run && run.endedAt === undefined ? run : { startedAt: now, responseMs: 0, output: 0 };
	}
	if (!run || run.endedAt !== undefined) return run;
	if (event.type === "agent_settled") {
		return { ...run, endedAt: Math.max(run.startedAt, now), responseStartedAt: undefined };
	}
	if (event.message?.role !== "assistant") return run;
	if (event.type === "message_start") return { ...run, responseStartedAt: now };
	if (event.type !== "message_end" || run.responseStartedAt === undefined) return run;
	const usage = event.message.usage;
	const output = usage && typeof usage === "object" && "output" in usage ? usage.output : undefined;
	const ms = now - run.responseStartedAt;
	const measured = typeof output === "number" && Number.isFinite(output) && output >= 0 && ms > 0;
	return {
		...run,
		responseStartedAt: undefined,
		responseMs: run.responseMs + (measured ? ms : 0),
		output: run.output + (measured ? output : 0),
	};
}

export function responseThroughput(run: PerformanceRun | null): number | undefined {
	return run && run.responseMs > 0 && run.output > 0 ? (run.output * 1000) / run.responseMs : undefined;
}

/** Use the SDK's cumulative statistics, including tool-only responses and compacted history. */
export function performanceUsage(stats: SessionInspector["stats"] | undefined) {
	if (!stats) return undefined;
	const { input, output, cacheRead, cacheWrite } = stats.tokens;
	if (![input, output, cacheRead, cacheWrite].every((value) => Number.isFinite(value) && value >= 0)) return undefined;
	const totalInput = input + cacheRead + cacheWrite;
	return {
		input: totalInput,
		output,
		cacheHit: cacheRead + cacheWrite > 0 && totalInput > 0 ? cacheRead / totalInput : undefined,
	};
}

export function performanceDuration(ms: number): string {
	const seconds = Math.floor(Math.max(0, ms) / 1000);
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
