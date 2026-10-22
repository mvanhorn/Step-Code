import { useEffect, useRef } from "react";
import { useT } from "../../i18n";
import { IconButton, Modal } from "../../ui";
import {
	closeFeedback,
	FEEDBACK_TOPIC_LABELS,
	FEEDBACK_TOPICS,
	type Sentiment,
	setFeedbackComment,
	setFeedbackSentiment,
	submitFeedback,
	toggleFeedbackTopic,
	useFeedbackState,
} from "./feedback";

const SENTIMENTS: readonly { readonly value: Sentiment; readonly labelKey: "feedbackGood" | "feedbackBad" }[] = [
	{ value: "up", labelKey: "feedbackGood" },
	{ value: "down", labelKey: "feedbackBad" },
];

/**
 * `#feedbackModal` (legacy index.html 1116-1157; app.js 2128-2185, 3390-3397):
 * sentiment, topic chips, a free-text box and one submit button. The vote
 * buttons open it with a sentiment already picked; `/feedback` opens it neutral,
 * so the same dialog serves both entries. Closes on the close button, a backdrop
 * click or Escape.
 */
export function FeedbackModal() {
	const t = useT();
	const feedback = useFeedbackState();
	const commentRef = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		if (!feedback.openSeq) return;
		const frame = requestAnimationFrame(() => commentRef.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, [feedback.openSeq]);
	return (
		<Modal
			open={feedback.open}
			onClose={closeFeedback}
			id="feedbackModal"
			overlayClassName="feedback-overlay"
			className="feedback-dialog"
			labelledBy="feedbackTitle"
			closeOnEscape
		>
			<header>
				<h2 id="feedbackTitle">{t("submitFeedback")}</h2>
				<IconButton id="feedbackClose" icon="close-sm" title="关闭" aria-label="关闭" onClick={closeFeedback} />
			</header>
			{/* biome-ignore lint/a11y/useSemanticElements: legacy markup is div[role=group]; a fieldset would change the chip layout. */}
			<div className="feedback-topics" id="feedbackSentiments" role="group" aria-label={t("submitFeedback")}>
				{SENTIMENTS.map((sentiment) => (
					<button
						key={sentiment.value}
						className="feedback-topic"
						type="button"
						data-sentiment={sentiment.value}
						aria-pressed={feedback.sentiment === sentiment.value}
						onClick={() => setFeedbackSentiment(sentiment.value)}
					>
						{t(sentiment.labelKey)}
					</button>
				))}
			</div>
			{/* biome-ignore lint/a11y/useSemanticElements: legacy markup is div[role=group]; a fieldset would change the chip layout. */}
			<div className="feedback-topics" id="feedbackTopics" role="group" aria-label="反馈主题">
				{FEEDBACK_TOPICS.map((topic) => {
					const key = `feedbackTopic.${topic}`;
					const label = t(key) === key ? FEEDBACK_TOPIC_LABELS[topic] : t(key);
					return (
						<button
							key={topic}
							className="feedback-topic"
							type="button"
							aria-pressed={feedback.topic === topic}
							onClick={() => toggleFeedbackTopic(topic)}
						>
							{label}
						</button>
					);
				})}
			</div>
			<textarea
				id="feedbackComment"
				ref={commentRef}
				rows={5}
				placeholder={t("feedbackCommentPlaceholder")}
				value={feedback.comment}
				onChange={(event) => setFeedbackComment(event.target.value)}
			/>
			<button
				className="feedback-submit"
				id="feedbackSubmit"
				type="button"
				disabled={feedback.submitting || feedback.sentiment === null}
				onClick={() => void submitFeedback()}
			>
				{t("submit")}
			</button>
		</Modal>
	);
}
