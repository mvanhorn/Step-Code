/**
 * `.goal-strip`: the session's goal, docked above the composer card next to the
 * queue dock. Unlike the one-shot mode chip, a goal outlives the message that
 * created it: it keeps running across turns until it completes or the user
 * stops it, so it needs its own persistent controls (pause, edit, delete).
 *
 * Stays mounted and toggles `hidden`, like every other overlay here.
 */

import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../../i18n";
import { apiSend, errorMessage } from "../../lib/api";
import { useImeGuard } from "../../lib/ime";
import { refreshCurrent, showError } from "../../state/session";
import { useAppStore } from "../../state/store";
import type { GoalState } from "../../state/types";
import { Icon, IconButton, Tooltip } from "../../ui";

type GoalAction = "start" | "pause" | "resume" | "edit" | "clear";

/** Status text for the strip; `active` is the only running state. */
function statusKey(status: GoalState["status"]): string {
	switch (status) {
		case "active":
			return "goalActive";
		case "paused":
			return "goalPaused";
		case "blocked":
			return "goalBlocked";
		case "usage_limited":
			return "goalUsageLimited";
		case "budget_limited":
			return "goalBudgetLimited";
		case "complete":
			return "goalComplete";
	}
}

export function GoalStrip() {
	const t = useT();
	const goal = useAppStore((state) => state.current?.goal);
	const sessionId = useAppStore((state) => state.current?.id);
	const [editing, setEditing] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const editor = useRef<HTMLInputElement | null>(null);
	const ime = useImeGuard();
	const editorId = useId();

	// The edit form belongs to one goal; a replaced or cleared goal closes it.
	useEffect(() => {
		if (editing !== null && goal?.id !== editing) setEditing(null);
	}, [editing, goal]);
	useEffect(() => {
		if (editing !== null) editor.current?.focus();
	}, [editing]);

	const send = async (action: GoalAction, objective?: string): Promise<void> => {
		if (!sessionId || busy) return;
		setBusy(true);
		try {
			await apiSend(`/api/v1/sessions/${sessionId}/goal`, "PATCH", {
				action,
				...(objective === undefined ? {} : { objective }),
			});
			if (action === "edit" || action === "clear") setEditing(null);
			// The goal is persisted state; re-read it rather than guessing the result.
			await refreshCurrent();
		} catch (error) {
			showError(errorMessage(error));
		} finally {
			setBusy(false);
		}
	};

	const submitEdit = (): void => {
		const text = draft.trim();
		if (!text) return;
		void send("edit", text);
	};

	const active = goal?.status === "active";

	return (
		<section className="goal-strip" id="goalStrip" hidden={!goal} aria-label={t("goalStripLabel")}>
			<Icon name="target" size="sm" className="goal-strip-lead" />
			<div className="goal-strip-body">
				{editing !== null ? (
					<input
						id={editorId}
						ref={editor}
						className="goal-strip-editor"
						value={draft}
						aria-label={t("goalEditLabel")}
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={(event) => {
							if (ime.isComposing(event)) return;
							if (event.key === "Enter") {
								event.preventDefault();
								submitEdit();
							}
							if (event.key === "Escape") {
								event.preventDefault();
								setEditing(null);
							}
						}}
					/>
				) : (
					<>
						<span className="goal-strip-title">{t("goalStripTitle")}</span>
						<span className="goal-strip-objective">{goal?.objective ?? ""}</span>
						<span className="goal-strip-status">
							{goal ? t(statusKey(goal.status)) : ""}
							{goal && goal.rounds > 0 ? t("goalRounds", { rounds: goal.rounds }) : ""}
						</span>
					</>
				)}
			</div>
			<div className="goal-strip-actions">
				{editing !== null ? (
					<>
						<button type="button" className="goal-strip-text" onClick={submitEdit} disabled={busy}>
							{t("goalSave")}
						</button>
						<button type="button" className="goal-strip-text" onClick={() => setEditing(null)}>
							{t("goalCancel")}
						</button>
					</>
				) : (
					<>
						<Tooltip content={active ? t("goalPause") : t("goalResume")}>
							<IconButton
								id="goalPause"
								icon={active ? "stop" : "orbit"}
								iconSize="sm"
								disabled={busy || goal?.status === "complete"}
								aria-label={active ? t("goalPause") : t("goalResume")}
								onClick={() => void send(active ? "pause" : "resume")}
							/>
						</Tooltip>
						<Tooltip content={t("goalEdit")}>
							<IconButton
								id="goalEdit"
								icon="pencil"
								iconSize="sm"
								disabled={busy}
								aria-label={t("goalEdit")}
								onClick={() => {
									if (!goal) return;
									setDraft(goal.objective);
									setEditing(goal.id);
								}}
							/>
						</Tooltip>
						<Tooltip content={t("goalDelete")}>
							<IconButton
								id="goalDelete"
								icon="trash"
								iconSize="sm"
								disabled={busy}
								aria-label={t("goalDelete")}
								onClick={() => void send("clear")}
							/>
						</Tooltip>
					</>
				)}
			</div>
		</section>
	);
}
