import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { api, errorMessage } from "../../lib/api";
import {
	activeRightPanel,
	closeRightPanel,
	openRightPanel,
	summaryActivityTurn,
	toggleRightPanel,
	toggleRightPanelExpanded,
} from "../../state/right-panel";
import { getState, type RightPanelId, setUi, useAppStore } from "../../state/store";
import type { SessionInspector } from "../../state/types";
import { IconButton, type IconName, Menu, MenuItem, Popover, ResizeHandle, Tooltip } from "../../ui";
import { BrowserPanel } from "../browser";
import { ChildAgentView } from "../conversation";
import { PreviewPanel } from "../files";
import { applyPreviewWidth, PREVIEW_DEFAULT, restorePreviewWidth } from "../files/actions";
import { TerminalPanel } from "../terminal";
import { ContextPanel } from "./ContextPanel";
import { SummaryBoard } from "./SummaryBoard";
import { SummaryHeader } from "./SummaryHeader";

const PANELS: readonly { id: RightPanelId; icon: IconName; label: string }[] = [
	{ id: "summary", icon: "layers", label: "rightSummary" },
	{ id: "context", icon: "scanLine", label: "rightContext" },
	{ id: "terminal", icon: "terminal", label: "terminalTitle" },
	{ id: "changes", icon: "fileDiff", label: "rightChanges" },
	{ id: "files", icon: "fileText", label: "filePreview" },
	{ id: "subagent", icon: "bot", label: "subagents" },
	{ id: "browser", icon: "globe", label: "browserTitle" },
];

export function RightToolRail() {
	const t = useT();
	const active = useAppStore(activeRightPanel);
	return (
		<nav className="right-tool-rail" aria-label={t("rightTools")}>
			{PANELS.map((panel) => (
				<Tooltip key={panel.id} content={t(panel.label)}>
					<IconButton
						data-right-panel={panel.id}
						icon={panel.icon}
						aria-label={t(panel.label)}
						aria-controls="rightPanel"
						aria-pressed={active === panel.id}
						onClick={() => toggleRightPanel(panel.id)}
					/>
				</Tooltip>
			))}
		</nav>
	);
}

export function RightPanel() {
	const t = useT();
	const panel = useAppStore(activeRightPanel);
	const expanded = useAppStore((state) => state.ui.rightPanelExpanded);
	const currentId = useAppStore((state) => state.current?.id);
	const activityTurn = useAppStore(summaryActivityTurn);
	const activitySeen = useRef<{ sessionId?: string; turn?: string }>({});
	const childParentId = useAppStore((state) => state.ui.childView?.parentId);
	const status = useAppStore((state) => state.current?.status);
	const [result, setResult] = useState<{ id: string; data?: SessionInspector; error?: string }>();
	const [revision, setRevision] = useState(0);
	const widthOpen = useAppStore((state) => state.ui.rightPanelMenu);
	const ref = useRef<HTMLElement>(null);
	const showStats = panel === "summary" || panel === "context";
	const summary = panel === "summary";
	useEffect(() => {
		if (activitySeen.current.sessionId !== currentId) activitySeen.current = { sessionId: currentId };
		if (!activityTurn || activitySeen.current.turn === activityTurn) return;
		// Consume once even when another inspector is active, so closing it cannot reveal stale activity.
		activitySeen.current.turn = activityTurn;
		if (!activeRightPanel(getState())) openRightPanel("summary");
	}, [currentId, activityTurn]);
	useEffect(() => restorePreviewWidth(), []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly requests a fresh read of the same session.
	useEffect(() => {
		if (!showStats || !currentId) return;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const read = async () => {
			try {
				const data = await api<SessionInspector>(`/api/v1/sessions/${encodeURIComponent(currentId)}/inspector`, {
					signal: controller.signal,
				});
				if (!controller.signal.aborted && data.sessionId === currentId) setResult({ id: currentId, data });
			} catch (error) {
				if (!controller.signal.aborted) setResult({ id: currentId, error: errorMessage(error) });
			}
			if (!controller.signal.aborted)
				timer = setTimeout(read, status === "running" || status === "waiting" ? 2000 : 5000);
		};
		void read();
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [currentId, showStats, status, revision]);
	const data = currentId === result?.id ? result?.data : undefined;
	const error = currentId === result?.id ? result?.error : undefined;
	return (
		<aside
			id="rightPanel"
			ref={ref}
			className={`right-panel${summary ? " summary-board" : ""}${panel === "browser" ? " is-browser" : ""}${panel === "terminal" ? " is-terminal" : ""}${expanded ? " is-expanded" : ""}`}
			aria-label={t(PANELS.find((entry) => entry.id === panel)?.label ?? "rightTools")}
			hidden={!panel}
		>
			<ResizeHandle
				bare
				className="preview-resizer"
				direction={-1}
				getSize={() => ref.current?.getBoundingClientRect().width ?? PREVIEW_DEFAULT}
				onResize={(width) => applyPreviewWidth(width, false)}
				onCommit={(width) => applyPreviewWidth(width)}
				onReset={() => applyPreviewWidth(PREVIEW_DEFAULT)}
				onDraggingChange={(resizing) => setUi({ resizing })}
				hidden={summary}
			/>
			<header className="right-panel-header">
				{summary ? (
					<SummaryHeader data={data} />
				) : (
					<h2>{t(PANELS.find((entry) => entry.id === panel)?.label ?? "rightTools")}</h2>
				)}
				{showStats && !summary ? (
					<Tooltip content={t("refresh")}>
						<IconButton
							icon="refresh"
							aria-label={t("refresh")}
							onClick={() => setRevision((value) => value + 1)}
						/>
					</Tooltip>
				) : null}
				{!summary ? (
					<Popover
						open={widthOpen}
						onClose={() => setUi({ rightPanelMenu: false })}
						closeOnEscape={false}
						placement="bottom-end"
						content={
							<Menu role="menu">
								{[
									{ label: "rightStandard", width: 420 },
									{ label: "rightWide", width: 620 },
								].map((choice) => (
									<MenuItem
										key={choice.label}
										role="menuitem"
										onClick={() => {
											applyPreviewWidth(choice.width);
											setUi({ rightPanelExpanded: false });
											setUi({ rightPanelMenu: false });
										}}
									>
										{t(choice.label)}
									</MenuItem>
								))}
							</Menu>
						}
					>
						<Tooltip content={t("rightWidth")}>
							<IconButton
								icon="panelRight"
								aria-label={t("rightWidth")}
								aria-haspopup="menu"
								aria-expanded={widthOpen}
								onClick={() => setUi({ rightPanelMenu: !widthOpen })}
							/>
						</Tooltip>
					</Popover>
				) : null}
				{!summary ? (
					<Tooltip content={t(expanded ? "rightRestore" : "rightExpand")}>
						<IconButton
							icon={expanded ? "minimize" : "maximize"}
							aria-label={t(expanded ? "rightRestore" : "rightExpand")}
							aria-pressed={expanded}
							onClick={toggleRightPanelExpanded}
						/>
					</Tooltip>
				) : null}
				<Tooltip content={t("subagentClose")}>
					<IconButton icon="close" aria-label={t("subagentClose")} onClick={closeRightPanel} />
				</Tooltip>
			</header>
			{error && showStats ? (
				<p className="right-panel-error" role="alert">
					{error}
				</p>
			) : null}
			<div className="right-panel-scroll" hidden={panel !== "summary"}>
				<SummaryBoard key={`summary-${currentId ?? ""}`} data={data} />
			</div>
			<div className="right-panel-scroll" hidden={panel !== "context"}>
				<ContextPanel key={`context-${currentId ?? ""}`} data={data} />
			</div>
			<PreviewPanel embedded />
			<ChildAgentView embedded />
			<BrowserPanel open={panel === "browser"} />
			<TerminalPanel open={panel === "terminal"} />
			{panel === "subagent" && (!currentId || childParentId !== currentId) ? (
				<p className="preview-message">{t("rightNoSubagent")}</p>
			) : null}
		</aside>
	);
}
