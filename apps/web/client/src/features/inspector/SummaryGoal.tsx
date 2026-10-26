/**
 * `.sb-goal`: the goal's lifecycle section at the top of the summary board —
 * status, live progress (rounds, active time, tokens against the budget) and
 * the controls (pause / resume / reword / clear). The flow marks each round
 * with a separator; this section is how the run is steered. A finished goal
 * collapses to one line, and no goal at all leaves the board unchanged.
 */

import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { apiSend, errorMessage } from "../../lib/api";
import { useImeGuard } from "../../lib/ime";
import { refreshCurrent, showError } from "../../state/session";
import { useAppStore } from "../../state/store";
import type { GoalState } from "../../state/types";
import { Button, Icon } from "../../ui";

type GoalAction = "pause" | "resume" | "edit" | "clear";

/** Status text for the chip; `active` is the only running state. */
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

/** `mm:ss`, growing to `h:mm:ss` once an hour is past. */
function formatElapsed(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const two = (value: number): string => String(value).padStart(2, "0");
	const hours = Math.floor(total / 3_600);
	return hours > 0
		? `${hours}:${two(Math.floor((total % 3_600) / 60))}:${two(total % 60)}`
		: `${two(Math.floor(total / 60))}:${two(total % 60)}`;
}

export function SummaryGoal() {
	const t = useT();
	const goal = useAppStore((state) => state.current?.goal);
	const sessionId = useAppStore((state) => state.current?.id);
	const [editing, setEditing] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const editor = useRef<HTMLInputElement | null>(null);
	const ime = useImeGuard();

	// The edit form belongs to one goal; a replaced or cleared goal closes it.
	useEffect(() => {
		if (editing !== null && goal?.id !== editing) setEditing(null);
	}, [editing, goal]);
	useEffect(() => {
		if (editing !== null) editor.current?.focus();
	}, [editing]);

	/*
	 * The projection carries active-only seconds; between refreshes the clock
	 * runs client-side from the moment the snapshot arrived, mirroring the
	 * backend's rule that only an active goal accrues time.
	 */
	const syncedAt = useRef(Date.now());
	const [, tick] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a re-stated projection re-anchors the client clock.
	useEffect(() => {
		syncedAt.current = Date.now();
	}, [goal?.status, goal?.timeUsedSeconds]);
	const active = goal?.status === "active";
	useEffect(() => {
		if (!active) return;
		const timer = window.setInterval(() => tick((value) => value + 1), 1_000);
		return () => window.clearInterval(timer);
	}, [active]);

	if (!goal) return null;
	const elapsed = active
		? goal.timeUsedSeconds + Math.floor((Date.now() - syncedAt.current) / 1_000)
		: goal.timeUsedSeconds;

	const send = async (action: GoalAction, objective?: string): Promise<void> => {
		if (!sessionId || busy) return;
		setBusy(true);
		try {
			await apiSend(`/api/v1/sessions/${sessionId}/goal`, "PATCH", {
				action,
				...(objective === undefined ? {} : { objective }),
			});
			if (action === "edit") setEditing(null);
			// Clearing a finished goal folds the section away with it.
			if (action === "clear") setExpanded(false);
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
		if (text) void send("edit", text);
	};

	// A finished goal is history: one line until the user asks for the card.
	if (goal.status === "complete" && !expanded && editing === null) {
		return (
			<section className="sb-goal" data-status="complete" aria-label={t("rightGoal")}>
				{/* The completed-tasks trigger pattern, verbatim; the meta only clamps and adds figures. */}
				<button
					className="sb-completed-trigger sb-goal-done"
					type="button"
					aria-expanded={false}
					onClick={() => setExpanded(true)}
				>
					<Icon name="check" size="xs" />
					<span className="sb-goal-done-meta">
						{t("goalComplete")}
						{" · "}
						{t("goalDoneLine", {
							rounds: goal.rounds,
							time: formatElapsed(elapsed),
							tokens: goal.tokensUsed.toLocaleString(),
						})}
					</span>
					<Icon name="disclosure" size="xs" className="sb-fold-icon" />
				</button>
			</section>
		);
	}

	return (
		<section className="sb-goal" data-status={goal.status} aria-label={t("rightGoal")}>
			<div className="sb-section-heading">
				<h3>{t("rightGoal")}</h3>
				{goal.status === "complete" ? (
					<button
						className="sb-goal-fold"
						type="button"
						aria-expanded
						aria-label={t("goalCollapse")}
						onClick={() => setExpanded(false)}
					>
						<Icon name="disclosure" size="xs" className="sb-fold-icon is-open" />
					</button>
				) : (
					<span className="sb-goal-status">{t(statusKey(goal.status))}</span>
				)}
			</div>
			{editing !== null ? (
				<div className="sb-goal-edit">
					<input
						ref={editor}
						className="sb-goal-input"
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
					<div className="sb-goal-actions">
						<Button variant="primary" onClick={submitEdit} disabled={busy || !draft.trim()}>
							{t("goalSave")}
						</Button>
						<Button onClick={() => setEditing(null)} disabled={busy}>
							{t("goalCancel")}
						</Button>
					</div>
				</div>
			) : (
				<>
					<p className="sb-goal-objective">{goal.objective}</p>
					<p className="sb-goal-stats">
						{t("goalRounds", { rounds: goal.rounds })}
						{" · "}
						{t("goalElapsed", { time: formatElapsed(elapsed) })}
						{" · "}
						{t("goalTokens", {
							used: goal.tokensUsed.toLocaleString(),
							budget: goal.tokenBudget === undefined ? t("goalUnbounded") : goal.tokenBudget.toLocaleString(),
						})}
					</p>
					{goal.tokenBudget === undefined ? null : (
						<div
							className="sb-goal-progress"
							data-tight={goal.tokensUsed / goal.tokenBudget >= 0.8 ? "" : undefined}
							role="progressbar"
							aria-label={t("goalTokens", {
								used: goal.tokensUsed.toLocaleString(),
								budget: goal.tokenBudget.toLocaleString(),
							})}
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={Math.round((goal.tokensUsed / goal.tokenBudget) * 100)}
							aria-valuetext={t("goalTokens", {
								used: goal.tokensUsed.toLocaleString(),
								budget: goal.tokenBudget.toLocaleString(),
							})}
						>
							<div
								className="sb-goal-progress-fill"
								style={{ width: `${Math.min(100, (goal.tokensUsed / goal.tokenBudget) * 100)}%` }}
							/>
						</div>
					)}
					<div className="sb-goal-actions">
						<Button
							onClick={() => void send(active ? "pause" : "resume")}
							disabled={busy || goal.status === "complete"}
						>
							<Icon name={active ? "stop" : "orbit"} size="2xs" />
							{t(active ? "goalPause" : "goalResume")}
						</Button>
						<Button
							onClick={() => {
								setDraft(goal.objective);
								setEditing(goal.id);
							}}
							disabled={busy}
						>
							<Icon name="pencil" size="2xs" />
							{t("goalEdit")}
						</Button>
						<Button onClick={() => void send("clear")} disabled={busy}>
							<Icon name="trash" size="2xs" />
							{t("goalDelete")}
						</Button>
					</div>
				</>
			)}
		</section>
	);
}
