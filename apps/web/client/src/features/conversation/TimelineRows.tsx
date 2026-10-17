import { memo, useState } from "react";
import { useT } from "../../i18n";
import { cx } from "../../lib/format";
import type { ToolTimelineItem } from "../../state/types";
import { Icon, LEGACY_ICONS } from "../../ui";
import { openChildAgent, openWorkflowAgents } from "./actions";

export { ApprovalCard } from "./ApprovalCard";

/**
 * A tool call in the stream (legacy `renderTimeline` tool branch, app.js 2263-2271).
 * The one-line summary toggles the full arguments and result below it.
 * A call that started child agents links to their read-only transcripts.
 */
export const ToolRow = memo(function ToolRow({
	item,
	readOnly = false,
}: {
	readonly item: ToolTimelineItem;
	/** Inside a child agent's transcript, which links to no further children. */
	readonly readOnly?: boolean;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const output = item.outputDetail || item.outputSummary;
	return (
		<>
			<button
				type="button"
				className={cx("tool-row", item.state, open && "open")}
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
			>
				<Icon {...LEGACY_ICONS.tool} />
				<span className="tool-name">{item.toolName}</span>
				<span>·</span>
				<span>{item.inputSummary || "无输入摘要"}</span>
				{item.outputSummary ? (
					<>
						<span>·</span>
						<span>{item.outputSummary}</span>
					</>
				) : null}
			</button>
			{!readOnly && (item.children?.length || item.workflowRun) ? <ChildAgentLinks item={item} /> : null}
			{open ? (
				<div className="tool-detail">
					<div className="tool-detail-label">{t("toolInput")}</div>
					<pre>{item.inputDetail || item.inputSummary || "无输入摘要"}</pre>
					<div className="tool-detail-label">{t("toolOutput")}</div>
					<pre>{output || (item.state === "pending" ? t("toolRunning") : "")}</pre>
				</div>
			) : null}
		</>
	);
});

function ChildAgentLinks({ item }: { readonly item: ToolTimelineItem }) {
	const t = useT();
	const workflowRun = item.workflowRun;
	return (
		<div className="tool-children">
			{workflowRun ? (
				<button
					type="button"
					className="tool-child-link"
					data-workflow-run={workflowRun}
					onClick={() => openWorkflowAgents(workflowRun, `workflow · ${workflowRun}`)}
				>
					<Icon name="layers" size="xs" />
					<span>{t("childAgentWorkflowOpen")}</span>
				</button>
			) : null}
			{item.children?.map((child) => (
				<button
					key={child.sessionId}
					type="button"
					className="tool-child-link"
					data-child-session-id={child.sessionId}
					onClick={() => openChildAgent(child.sessionId, child.label || t("childAgent"))}
				>
					<Icon name="orbit" size="xs" />
					<span>{child.label || t("childAgentOpen")}</span>
				</button>
			))}
		</div>
	);
}
