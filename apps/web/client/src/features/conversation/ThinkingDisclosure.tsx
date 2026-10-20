import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import { renderMarkdown } from "../../lib/markdown";
import { copyText } from "../../state/session";
import { thinkingElapsed } from "../../state/thinking-timing";
import type { ThinkingTimelineItem } from "../../state/types";
import { Icon, MarkdownView } from "../../ui";
import { useFadeIn, useSmoothText } from "./streaming";

/** Standard presentation: folded by default; only an actual live block animates. */
export const ThinkingDisclosure = memo(function ThinkingDisclosure({
	item,
	active = false,
}: {
	readonly item: ThinkingTimelineItem;
	readonly active?: boolean;
}) {
	const t = useT();
	const running = active && item.running;
	const [expanded, setExpanded] = useState(false);
	const wasRunning = useRef(running);
	const bodyRef = useRef<HTMLDivElement>(null);
	const id = useId();
	const text = useSmoothText(item.content, running);
	const code = t("code");
	const copy = t("copy");
	const table = t("markdownTable");
	const html = useMemo(() => renderMarkdown(text, { code, copy, table }), [text, code, copy, table]);
	useFadeIn(bodyRef, html, running);
	useEffect(() => {
		if (wasRunning.current && !running) setExpanded(false);
		wasRunning.current = running;
	}, [running]);
	const label = t(running ? "thinkingIndicator" : "thinkingLabel");
	const preview = running ? item.content.replace(/\s+/g, " ").trim().slice(-160) : "";
	return (
		<section className="thinking" data-entry-id={item.entryId} data-running={running} data-expanded={expanded}>
			<button
				type="button"
				className={`thinking-summary tool-row${running ? " pending" : ""}`}
				aria-expanded={expanded}
				aria-controls={id}
				onClick={() => setExpanded((value) => !value)}
			>
				<Icon name="brain" size="xs" />
				<span className="tool-verb">
					{label}
					<span className="tool-pending" data-label={label} aria-hidden="true" />
				</span>
				<ThinkingElapsed timing={item.timing} active={running} />
				{!expanded && preview ? <span className="thinking-preview">{preview}</span> : null}
				<Icon name="disclosure" size="xs" className="thinking-chevron" />
			</button>
			<div
				id={id}
				className={`thinking-disclosure${expanded ? " expanded" : ""}`}
				aria-hidden={!expanded}
				inert={!expanded}
			>
				<div className="thinking-body">
					<MarkdownView
						ref={bodyRef}
						className="message-body"
						html={html}
						onCopyCode={(value) => void copyText(value)}
					/>
				</div>
			</div>
		</section>
	);
});

/** Only the live label ticks; settled history has no timer or invented endpoint. */
function ThinkingElapsed({
	timing,
	active,
}: {
	readonly timing: ThinkingTimelineItem["timing"];
	readonly active: boolean;
}) {
	const t = useT();
	const [now, setNow] = useState(Date.now);
	const running = active && timing !== undefined && timing.endedAt === undefined;
	useEffect(() => {
		if (!running) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [running]);
	if (!timing || (!running && timing.endedAt === undefined)) return null;
	return <span className="thinking-elapsed">{t("thinkingElapsed", { duration: thinkingElapsed(timing, now) })}</span>;
}
