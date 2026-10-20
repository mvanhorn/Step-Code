import { memo } from "react";
import { useT } from "../../i18n";
import { useAppStore } from "../../state/store";
import type { ToolTimelineItem } from "../../state/types";
import { Icon } from "../../ui";
import { openSubagentTask } from "./actions";
import { SubagentStatusIcon } from "./SubagentStatusIcon";

export const SubagentLane = memo(function SubagentLane({ item }: { readonly item: ToolTimelineItem }) {
	const t = useT();
	const selection = useAppStore((state) => state.ui.childView);
	return (
		<div className="subagent-lanes" data-tool-name="subagent">
			{item.subagentTasks?.map((task, index) => (
				<button
					// biome-ignore lint/suspicious/noArrayIndexKey: runtime task records retain dispatch order.
					key={index}
					type="button"
					className="lane-row tool-child-link"
					data-tool-state={
						task.status === "completed"
							? "done"
							: task.status === "queued"
								? "pending"
								: task.status === "aborted"
									? "stopped"
									: task.status
					}
					data-lane-agent={task.agent}
					data-child-session-id={task.sessionId}
					data-subagent-tool-id={item.itemId}
					data-subagent-task-index={index}
					aria-label={t("subagentOpenRecord", {
						status: t(`subagentStatus.${task.status}`),
						task: task.task || t("subagentNoTask"),
					})}
					aria-pressed={selection?.toolItemId === item.itemId && selection.taskIndex === index}
					onClick={() => openSubagentTask(item.itemId, index)}
				>
					<Icon name="bot" size="xs" />
					<SubagentStatusIcon status={task.status} />
					<span className="lane-type">{task.agent || t("subagent")}</span>
					<span className="lane-summary-text">
						{task.task.replace(/\s+/gu, " ").trim() || t("subagentNoTask")}
					</span>
					<Icon className="lane-chevron" name="disclosure" size="xs" />
				</button>
			))}
		</div>
	);
});
