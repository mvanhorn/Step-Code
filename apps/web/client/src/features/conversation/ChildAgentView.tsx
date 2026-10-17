import { useEffect, useMemo, useState } from "react";
import { useT } from "../../i18n";
import { api, errorMessage } from "../../lib/api";
import { cx } from "../../lib/format";
import { timelineFromEntries } from "../../state/session";
import { setUi, useAppStore } from "../../state/store";
import type { ChildAgentSummary, ChildSessionSnapshot } from "../../state/types";
import { Icon, IconButton } from "../../ui";
import { closeChildAgent } from "./actions";
import { MessageItem } from "./MessageItem";
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
		const run = () =>
			load().then(
				(value) => !cancelled && setState({ key, value }),
				(error: unknown) => !cancelled && setState({ key, error: errorMessage(error) }),
			);
		void run();
		const timer = live ? setInterval(run, REFRESH_MS) : undefined;
		return () => {
			cancelled = true;
			if (timer) clearInterval(timer);
		};
	}, [key, live]);
	return state.key === key ? state : {};
}

/**
 * `#childAgentView`: a child agent's transcript over the parent conversation.
 * Strictly read-only: there is no composer, and messages carry no vote or fork
 * actions. Opened from a subagent call (one child) or a workflow call (the
 * run's agents, as tabs). The parent stays selected in the sidebar.
 */
export function ChildAgentView() {
	const t = useT();
	const view = useAppStore((state) => state.ui.childView);
	const currentId = useAppStore((state) => state.current?.id);
	const parentBusy = useAppStore(
		(state) => state.current?.status === "running" || state.current?.status === "waiting",
	);
	const open = Boolean(view && view.parentId === currentId);
	const parentId = view?.parentId ?? "";
	const workflowRun = open ? view?.workflowRun : undefined;

	const agents = usePolled(workflowRun ? `${parentId}:${workflowRun}` : null, parentBusy, () =>
		api<{ children: ChildAgentSummary[] }>(
			`/api/v1/sessions/${encodeURIComponent(parentId)}/children?${new URLSearchParams({ workflowRun: workflowRun ?? "" })}`,
		).then((body) => body.children),
	);
	const childId = view?.childId ?? agents.value?.[0]?.id ?? null;
	const transcript = usePolled(open && childId ? `${parentId}:${childId}` : null, parentBusy, () =>
		api<ChildSessionSnapshot>(childPath(parentId, childId ?? "")),
	);
	const items = useMemo(() => timelineFromEntries(transcript.value?.entries ?? []), [transcript.value]);
	const selectAgent = (id: string) => {
		if (view) setUi({ childView: { ...view, childId: id } });
	};
	const emptyText = transcript.error
		? transcript.error
		: workflowRun && agents.value?.length === 0
			? t("childAgentNoneInRun")
			: transcript.value
				? t("childAgentEmpty")
				: t("childAgentLoading");

	return (
		<div className={cx("child-agent-view", open && "open")} id="childAgentView" hidden={!open}>
			<header className="child-agent-header">
				<IconButton
					id="childAgentBack"
					icon="back"
					title={t("backToConversation")}
					aria-label={t("backToConversation")}
					onClick={closeChildAgent}
				/>
				<Icon name={workflowRun ? "layers" : "orbit"} size="sm" />
				<strong className="child-agent-title">{view?.label || t("childAgent")}</strong>
				<span className="child-agent-badge">{t("childAgentReadOnly")}</span>
			</header>
			{workflowRun && agents.value?.length ? (
				<div className="child-agent-tabs" role="tablist" aria-label={t("childAgentList")}>
					{agents.value.map((agent, index) => (
						<button
							key={agent.id}
							type="button"
							role="tab"
							aria-selected={agent.id === childId}
							className={cx("child-agent-tab", agent.id === childId && "active")}
							data-child-session-id={agent.id}
							data-tooltip={agent.title}
							onClick={() => selectAgent(agent.id)}
						>
							<span className="child-agent-tab-index">#{index + 1}</span>
							<span>{agent.title || agent.id}</span>
						</button>
					))}
				</div>
			) : null}
			<div className="stream child-agent-stream">
				<div className="stream-inner">
					{items.length ? (
						items.map((item) =>
							item.kind === "message" ? (
								<MessageItem key={item.itemId} item={item} readOnly />
							) : item.kind === "tool" ? (
								<ToolRow key={item.itemId} item={item} readOnly />
							) : null,
						)
					) : (
						<p className="child-agent-empty">{emptyText}</p>
					)}
				</div>
			</div>
		</div>
	);
}
