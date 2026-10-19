/**
 * The kernel's automatic retry of a failed model request, as a reloaded page
 * needs to see it again.
 *
 * `AgentSession` announces each retry with `auto_retry_start` (attempt, cap,
 * backoff) and ends the series with `auto_retry_end`. A page that connects
 * during the backoff, or during the retried request, missed the start event,
 * so the active retry is part of the session snapshot.
 */

import type { AgentSessionEvent } from "@step-harness/coding-agent";

/** The `retry` field of a session snapshot (openapi.yaml `SessionRetry`). */
export interface WebRetryState {
	/** 1-based attempt about to run. */
	readonly attempt: number;
	readonly maxAttempts: number;
	/** Backoff before the attempt starts. */
	readonly delayMs: number;
	/** Epoch milliseconds of the `auto_retry_start` that scheduled it. */
	readonly startedAt: number;
	/** The provider error that caused the retry. */
	readonly errorMessage: string;
	readonly reason?: "rate_limit";
}

export class RetryTracker {
	private current: WebRetryState | undefined;
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	/** Follow one session event. Returns whether the tracked retry changed. */
	apply(event: AgentSessionEvent): boolean {
		if (event.type === "auto_retry_start") {
			this.current = {
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
				delayMs: event.delayMs,
				startedAt: this.now(),
				errorMessage: event.errorMessage,
				...(event.reason ? { reason: event.reason } : {}),
			};
			return true;
		}
		// `agent_settled` also ends a series whose closing event never came (an
		// exception escaping a retried continuation skips `auto_retry_end`).
		if (event.type === "auto_retry_end" || event.type === "agent_settled") return this.clear();
		return false;
	}

	/** Forget the retry, e.g. when another session is bound. Returns whether one was tracked. */
	clear(): boolean {
		const had = this.current !== undefined;
		this.current = undefined;
		return had;
	}

	view(): WebRetryState | undefined {
		return this.current;
	}
}
