import { type AppState, getState, type RightPanelId, setState, setUi } from "./store";

/** File entry points remain authoritative when they open the existing preview. */
export function activeRightPanel(state: AppState): RightPanelId | null {
	return state.preview.open ? state.preview.mode : state.ui.rightPanel;
}

/** Activity reveals a presentation surface; it is never evidence of task completion. */
export function summaryActivityTurn(state: AppState): string | null {
	if (!state.current) return null;
	let activity = false;
	for (let index = state.timelineItems.length - 1; index >= 0; index--) {
		const item = state.timelineItems[index];
		if (item.kind === "message" && item.role === "user") return activity ? item.itemId : null;
		if (
			item.kind === "tool" &&
			(item.toolName === "task_create" ||
				item.toolName === "task_update" ||
				item.toolName === "subagent" ||
				item.toolName === "agent_send" ||
				Boolean(item.subagentTasks?.length))
		)
			activity = true;
	}
	return activity ? "history" : null;
}

export function openRightPanel(panel: RightPanelId | null): void {
	setState((state) => ({
		preview: {
			...state.preview,
			open: panel === "files" || panel === "changes",
			mode: panel === "changes" ? "changes" : panel === "files" ? "files" : state.preview.mode,
		},
		ui: { ...state.ui, rightPanel: panel, rightPanelExpanded: false, rightPanelMenu: false, changesMenu: null },
	}));
}

export function closeRightPanel(): void {
	const panel = activeRightPanel(getState());
	openRightPanel(null);
	if (typeof document !== "undefined" && panel) {
		requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-right-panel="${panel}"]`)?.focus());
	}
}

export function toggleRightPanel(panel: RightPanelId): void {
	if (activeRightPanel(getState()) === panel) closeRightPanel();
	else openRightPanel(panel);
}

export function toggleRightPanelExpanded(): void {
	setUi((ui) => ({ rightPanelExpanded: !ui.rightPanelExpanded }));
}
