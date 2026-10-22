/**
 * Feedback dialog state and actions (legacy app.js 2107-2185, `state.feedback`).
 *
 * The vote buttons live in the stream and the dialog is a separate slot, so the
 * state is a small feature-local store rather than component state.
 */

import { useSyncExternalStore } from "react";
import { t } from "../../i18n";
import { apiSend, errorMessage } from "../../lib/api";
import { showError } from "../../state/session";
import { createStore, getState } from "../../state/store";

/** Topic ids, mirroring FEEDBACK_TOPICS on the server. */
export const FEEDBACK_TOPICS = [
	"taskResult",
	"instructionFollowing",
	"productInteraction",
	"stabilitySpeed",
	"resourceCost",
	"safetyPrivacy",
	"other",
] as const;

export type FeedbackTopic = (typeof FEEDBACK_TOPICS)[number];
export type Sentiment = "up" | "down";

/** Labels used when a locale has no `feedbackTopic.*` entry (legacy FEEDBACK_TOPIC_LABELS). */
export const FEEDBACK_TOPIC_LABELS: Readonly<Record<FeedbackTopic, string>> = {
	taskResult: "任务结果",
	instructionFollowing: "指令理解与遵循",
	productInteraction: "产品功能与交互",
	stabilitySpeed: "稳定性和速度",
	resourceCost: "资源使用与费用",
	safetyPrivacy: "安全隐私与权限",
	other: "其他",
};

export interface FeedbackState {
	readonly open: boolean;
	/** Null when the dialog was opened without a vote (`/feedback`): the user picks one there. */
	readonly sentiment: Sentiment | null;
	readonly topic: FeedbackTopic | null;
	readonly comment: string;
	readonly submitting: boolean;
	/** Incremented on every open so the dialog can focus the comment box. */
	readonly openSeq: number;
}

const feedbackStore = createStore<FeedbackState>({
	open: false,
	sentiment: null,
	topic: null,
	comment: "",
	submitting: false,
	openSeq: 0,
});

export function useFeedbackState(): FeedbackState {
	return useSyncExternalStore(feedbackStore.subscribe, feedbackStore.getState, feedbackStore.getState);
}

/**
 * Open the dialog. The vote buttons pass their sentiment; `/feedback` opens it
 * neutral and lets the user choose before submitting.
 */
export function openFeedback(sentiment?: Sentiment): void {
	feedbackStore.setState((state) => ({
		open: true,
		sentiment: sentiment ?? null,
		topic: null,
		comment: "",
		openSeq: state.openSeq + 1,
	}));
}

/** Choose the sentiment inside an already-open dialog (`/feedback`). */
export function setFeedbackSentiment(sentiment: Sentiment): void {
	feedbackStore.setState({ sentiment });
}

export function closeFeedback(): void {
	feedbackStore.setState({ open: false });
}

/** Clicking the selected topic clears it. */
export function toggleFeedbackTopic(topic: FeedbackTopic): void {
	feedbackStore.setState((state) => ({ topic: state.topic === topic ? null : topic }));
}

export function setFeedbackComment(comment: string): void {
	feedbackStore.setState({ comment });
}

/** POST the feedback for the current session (legacy `submitFeedback`, 2165-2185). */
export async function submitFeedback(): Promise<void> {
	const current = getState().current;
	const feedback = feedbackStore.getState();
	if (!current || !feedback.sentiment) return;
	feedbackStore.setState({ submitting: true });
	try {
		const result = await apiSend<{ message?: string }>(`/api/v1/sessions/${current.id}/feedback`, "POST", {
			sentiment: feedback.sentiment,
			comment: feedback.comment,
			...(feedback.topic ? { topic: feedback.topic } : {}),
		});
		closeFeedback();
		// Legacy used the default (danger) toast tone here too.
		showError(result.message || t("feedbackSubmitted"));
	} catch (error) {
		showError(errorMessage(error));
	} finally {
		feedbackStore.setState({ submitting: false });
	}
}
