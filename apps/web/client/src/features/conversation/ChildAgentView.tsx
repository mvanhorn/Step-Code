import { useEffect, useMemo, useState } from "react";
import { useT } from "../../i18n";
import { api, errorMessage } from "../../lib/api";
import { cx } from "../../lib/format";
import { activeRightPanel } from "../../state/right-panel";
import { timelineFromEntries } from "../../state/session";
import { setUi, useAppStore } from "../../state/store";
import type { ChildAgentSummary, ChildSessionSnapshot } from "../../state/types";
import { Icon, IconButton, Tooltip } from "../../ui";
import { closeChildAgent, openSubagentTask } from "./actions";
import { MessageItem } from "./MessageItem";
import { RetryRow } from "./RetryRow";
import { SubagentStatusIcon } from "./SubagentStatusIcon";
import { ThinkingDisclosure } from "./ThinkingDisclosure";
import { ToolRow } from "./TimelineRows";

/** A running parent may still have children writing; their transcripts are re-read this often. */
const REFRESH_MS = 2000;

function childPath(parentId: string, childId: string): string {
	return `/api/v1/sessions/${encodeURIComponent(parentId)}/children/${encodeURIComponent(childId)}`;
}

/** Re-runs `load` every REFRESH_MS while `live`; the latest result wins. */
function usePolled<T>(key: string | null, live: boolean, load: () => Promise<T>): { value?: T; error?: string } {
	const [state, setState] = useState<{ key: string | null; value?: T; error?: string }>({ key: null });
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` identifies what `load` reads.
	useEffect(() => {
		if (!key) return;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const run = async () => {
			await load().then(
				(value) => !cancelled && setState({ key, value }),
				(error: unknown) => !cancelled && setState({ key, error: errorMessage(error) }),
			);
			if (!cancelled && live) timer = setTimeout(run, REFRESH_MS);
		};
		void run();
		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
		};
	}, [key, live]);
	return state.key === key ? state : {};
}

/**
 * `#childAgentView`: a responsive child transcript inspector beside the parent.
 * Strictly read-only: there is no composer, and messages carry no vote or fork
 * actions. Opened from a subagent call (one child) or a workflow call (the
 * run's agents, as tabs). The parent stays selected in the sidebar.
 */
export function ChildAgentView({ embedded = false }: { readonly embedded?: boolean }) {
	const t = useT();
	const view = useAppStore((state) => state.ui.childView);
	const currentId = useAppStore((state) => state.current?.id);
	const panel = useAppStore(activeRightPanel);
	const selectedTool = useAppStore((state) => state.timelineItems.find((item) => item.itemId === view?.toolItemId));
	const tasks = selectedTool?.kind === "tool" ? selectedTool.subagentTasks : undefined;
	const task = view?.taskIndex === undefined ? undefined : tasks?.[view.taskIndex];
	const dispatchError =
		!task && selectedTool?.kind === "tool" && selectedTool.state === "failed"
			? selectedTool.outputDetail || selectedTool.outputSummary
			: "";
	const [expanded, setExpanded] = useState(false);
	const parentBusy = useAppStore(
		(state) => state.current?.status === "running" || state.current?.status === "waiting",
	);
	const open = Boolean(view && view.parentId === currentId && (!embedded || panel === "subagent"));
	const parentId = view?.parentId ?? "";
	const workflowRun = open ? view?.workflowRun : undefined;

	const agents = usePolled(workflowRun ? `${parentId}:${workflowRun}` : null, parentBusy, () =>
		api<{ children: ChildAgentSummary[] }>(
			`/api/v1/sessions/${encodeURIComponent(parentId)}/children?${new URLSearchParams({ workflowRun: workflowRun ?? "" })}`,
		).then((body) => body.children),
	);
	const childId = task?.sessionId ?? view?.childId ?? agents.value?.[0]?.id ?? null;
	const transcript = usePolled(
		open && childId ? `${parentId}:${childId}` : null,
		parentBusy || task?.status === "running",
		() => api<ChildSessionSnapshot>(childPath(parentId, childId ?? "")),
	);
	const items = useMemo(() => timelineFromEntries(transcript.value?.entries ?? []), [transcript.value]);
	const selectAgent = (id: string) => {
		if (view) setUi({ childView: { ...view, childId: id } });
	};
	const emptyText = dispatchError
		? dispatchError
		: view?.toolItemId && !task
			? t("subagentNoTranscript")
			: transcript.error || agents.error
				? transcript.error || agents.error
				: workflowRun && agents.value?.length === 0
					? t("childAgentNoneInRun")
					: task && !childId
						? t(
								task.status === "queued" || task.status === "running"
									? "subagentWaitingTranscript"
									: "subagentNoTranscript",
							)
						: transcript.value
							? t("childAgentEmpty")
							: t("childAgentLoading");

	return (
		<section
			className={cx("child-agent-view", open && "open", expanded && "expanded")}
			id="childAgentView"
			hidden={!open}
			aria-label={t("childAgent")}
		>
			<header className="child-agent-header" hidden={embedded}>
				<IconButton
					id="childAgentBack"
					icon="back"
					title={t("backToConversation")}
					aria-label={t("backToConversation")}
					onClick={closeChildAgent}
				/>
				<Icon name={workflowRun ? "layers" : "bot"} size="sm" />
				<strong className="child-agent-title">{workflowRun ? view?.label : t("subagents")}</strong>
				<span className="child-agent-badge">{t("childAgentReadOnly")}</span>
				<IconButton
					icon="panelRight"
					className="child-agent-expand"
					aria-label={t(expanded ? "subagentCollapse" : "subagentExpand")}
					data-tooltip={t(expanded ? "subagentCollapse" : "subagentExpand")}
					aria-pressed={expanded}
					onClick={() => setExpanded((value) => !value)}
				/>
				<IconButton
					icon="close"
					aria-label={t("subagentClose")}
					data-tooltip={t("subagentClose")}
					onClick={closeChildAgent}
				/>
			</header>
			{tasks && tasks.length > 1 ? (
				<section className="child-agent-tabs" aria-label={t("childAgentList")}>
					{tasks.map((candidate, index) => (
						<button
							// biome-ignore lint/suspicious/noArrayIndexKey: runtime task order is stable.
							key={index}
							type="button"
							className={cx("child-agent-tab", index === view?.taskIndex && "active")}
							aria-pressed={index === view?.taskIndex}
							onClick={() => view?.toolItemId && openSubagentTask(view.toolItemId, index)}
						>
							<SubagentStatusIcon status={candidate.status} />
							<span>
								{candidate.agent || t("subagent")} · {index + 1}
							</span>
						</button>
					))}
				</section>
			) : null}
			{workflowRun && agents.value?.length ? (
				<div className="child-agent-tabs" role="tablist" aria-label={t("childAgentList")}>
					{agents.value.map((agent, index) => (
						<Tooltip key={agent.id} content={agent.title}>
							<button
								type="button"
								role="tab"
								aria-selected={agent.id === childId}
								className={cx("child-agent-tab", agent.id === childId && "active")}
								data-child-session-id={agent.id}
								onClick={() => selectAgent(agent.id)}
							>
								<span className="child-agent-tab-index">#{index + 1}</span>
								<span>{agent.title || agent.id}</span>
							</button>
						</Tooltip>
					))}
				</div>
			) : null}
			<div className="stream child-agent-stream">
				<div className="stream-inner">
					{task ? (
						<section className="subagent-task-detail">
							<div className="subagent-head">
								<span className="lane-type">{task.agent || t("subagent")}</span>
								<SubagentStatusIcon status={task.status} />
								<span className="subagent-state-label">{t(`subagentStatus.${task.status}`)}</span>
								<span className="subagent-meta">
									{task.model}
									{task.turns !== undefined ? <span>{t("subagentTurns", { count: task.turns })}</span> : null}
								</span>
							</div>
							<p className="subagent-task">{task.task || t("subagentNoTask")}</p>
							{task.error ? (
								<p className="subagent-error" role="alert">
									{task.error}
								</p>
							) : null}
						</section>
					) : null}
					{!task && view?.label ? <p className="subagent-task">{view.label}</p> : null}
					{items.length ? (
						items.map((item) =>
							item.kind === "message" ? (
								<MessageItem key={item.itemId} item={item} />
							) : item.kind === "tool" ? (
								<ToolRow key={item.itemId} item={item} readOnly />
							) : item.kind === "thinking" ? (
								<ThinkingDisclosure key={item.itemId} item={item} />
							) : item.kind === "retry" ? (
								<RetryRow key={item.itemId} item={item} />
							) : null,
						)
					) : (
						<p
							className={cx("child-agent-empty", dispatchError && "subagent-error")}
							role={dispatchError ? "alert" : undefined}
						>
							{emptyText}
						</p>
					)}
				</div>
			</div>
		</section>
	);
}
