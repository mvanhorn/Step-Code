import "./performance-bar.css";

import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { api } from "../../lib/api";
import { formatTokens } from "../../lib/format";
import { performanceDuration, performanceUsage, responseThroughput } from "../../state/performance";
import { useAppStore } from "../../state/store";
import type { SessionInspector } from "../../state/types";
import { Icon, Tooltip } from "../../ui";

export function PerformanceBar() {
	const t = useT();
	const sessionId = useAppStore((state) => state.current?.id);
	const status = useAppStore((state) => state.current?.status);
	const lastEntry = useAppStore((state) => state.current?.entries?.at(-1)?.id);
	const run = useAppStore((state) => state.performanceRun);
	const [now, setNow] = useState(() => performance.now());
	const [result, setResult] = useState<{ id: string; stats?: SessionInspector["stats"]; error?: true }>();
	const running = Boolean(run && run.endedAt === undefined);
	useEffect(() => {
		if (!running) return;
		setNow(performance.now());
		const timer = setInterval(() => setNow(performance.now()), 1000);
		return () => clearInterval(timer);
	}, [running]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a newly recorded entry refreshes canonical usage.
	useEffect(() => {
		if (!sessionId) return;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const read = async () => {
			try {
				const data = await api<SessionInspector>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/inspector`, {
					signal: controller.signal,
				});
				if (!controller.signal.aborted && data.sessionId === sessionId)
					setResult({ id: sessionId, stats: data.stats });
			} catch {
				// Failed statistics are unavailable, not zero or stale successful values.
				if (!controller.signal.aborted) setResult({ id: sessionId, error: true });
			}
			if (!controller.signal.aborted && (status === "running" || status === "waiting"))
				timer = setTimeout(read, 2000);
		};
		void read();
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [sessionId, status, lastEntry]);
	const usage = performanceUsage(result?.id === sessionId ? result?.stats : undefined);
	const unavailable = "\u2014";
	const elapsed = run ? performanceDuration((run.endedAt ?? now) - run.startedAt) : unavailable;
	const speed = responseThroughput(run);
	const throughput = speed === undefined ? unavailable : `${speed.toFixed(1)} tok/s`;
	/* Labelled, so the pair does not read as a fraction. */
	const tokens = usage
		? t("performanceInOut", { input: formatTokens(usage.input), output: formatTokens(usage.output) })
		: `${unavailable} / ${unavailable}`;
	const hit = usage?.cacheHit === undefined ? unavailable : `${Math.round(usage.cacheHit * 100)}%`;
	/* A metric with no reading yet is left out rather than shown as a dash; the bar reads as unfinished otherwise. */
	const hasElapsed = Boolean(run);
	const hasSpeed = speed !== undefined;
	const hasHit = usage?.cacheHit !== undefined;
	const usageHint =
		result?.id === sessionId && result?.error ? t("performanceUnavailable") : t("performanceTokensHint");
	return (
		<section className="performance-bar" aria-label={t("performanceTitle")} data-running={running}>
			{hasElapsed ? (
				<Tooltip content={t("performanceElapsedHint")}>
					<span className="performance-metric" role="img" aria-label={t("performanceElapsed", { value: elapsed })}>
						<Icon name="timer" size="xs" />
						<span className="performance-elapsed">{elapsed}</span>
					</span>
				</Tooltip>
			) : null}
			{hasSpeed ? (
				<Tooltip content={t("performanceSpeedHint")}>
					<span
						className="performance-metric"
						role="img"
						aria-label={t("performanceSpeed", { value: throughput })}
					>
						<Icon name="zap" size="xs" />
						<span className="performance-speed">{throughput}</span>
					</span>
				</Tooltip>
			) : null}
			<Tooltip content={usageHint}>
				<span className="performance-metric" role="img" aria-label={t("performanceTokens", { value: tokens })}>
					<Icon name="database" size="xs" />
					<span>{tokens}</span>
				</span>
			</Tooltip>
			{hasHit ? (
				<Tooltip content={t("performanceCacheHint")}>
					<span className="performance-metric">
						{t("performanceCacheTotal")} <span>{hit}</span>
					</span>
				</Tooltip>
			) : null}
		</section>
	);
}
