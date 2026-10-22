/**
 * `.plan-review`: the proposal an `exit_plan_mode` call submitted, shown when
 * the host has no review dialog of its own.
 *
 * Planning is investigation plus a written proposal, and exiting reports that
 * the investigation finished — it never authorizes the work. So the card asks
 * the user, in two ways the kernel already understands:
 *
 * - "request changes" sends the user's notes as a normal message, which is the
 *   same steering path the TUI's review dialog uses;
 * - "approve and run" sends a normal message that authorizes implementation.
 *
 * Both are ordinary user messages: the decision lands in the transcript, starts
 * one turn, and needs no special execution channel. `planHash` identifies the
 * reviewed text, so a card whose proposal was superseded stays inert.
 */

import { useState } from "react";
import { useT } from "../../i18n";
import type { PlanReview } from "../../state/types";
import { Icon } from "../../ui";
import { sendMessage } from "../composer/actions";

export function PlanReviewCard({ review }: { readonly review: PlanReview }) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const [notes, setNotes] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [settled, setSettled] = useState(false);

	const send = async (text: string): Promise<void> => {
		if (busy || !text.trim()) return;
		setBusy(true);
		try {
			// One decision per card: the proposal it answered is no longer current.
			if (await sendMessage(text)) setSettled(true);
		} finally {
			setBusy(false);
		}
	};

	const actionable = review.pending && !settled;

	return (
		<section className="plan-review" id="planReviewCard">
			<header className="plan-review-heading">
				<span className="plan-review-dot" aria-hidden="true" />
				<span className="plan-review-heading-title">
					{t(actionable ? "planReviewPending" : "planReviewSettled")}
				</span>
				<button
					type="button"
					className="plan-review-more"
					onClick={() => setExpanded((value) => !value)}
					aria-expanded={expanded}
				>
					{t(expanded ? "planReviewCollapse" : "planReviewExpand")}
					<Icon name="chevron" size="2xs" />
				</button>
			</header>
			<div className="plan-review-body">
				<pre className="plan-review-contents" id="planReviewContents" hidden={!expanded}>
					{review.planContents}
				</pre>
				{expanded ? null : (
					<p className="plan-review-summary" id="planReviewSummary">
						{firstParagraph(review.planContents)}
					</p>
				)}
			</div>
			{actionable ? (
				<footer className="plan-review-actions">
					{notes === null ? (
						<>
							<button
								type="button"
								className="plan-review-button"
								id="planRequestChanges"
								disabled={busy}
								onClick={() => setNotes("")}
							>
								<Icon name="pencil" size="xs" />
								{t("planRequestChanges")}
							</button>
							<button
								type="button"
								className="plan-review-button approve"
								id="planApprove"
								disabled={busy}
								onClick={() => void send(t("planApproveMessage"))}
							>
								{t("planApprove")}
							</button>
						</>
					) : (
						<div className="plan-review-notes">
							<textarea
								id="planReviewNotes"
								className="plan-review-textarea"
								value={notes}
								placeholder={t("planChangePlaceholder")}
								aria-label={t("planChangePlaceholder")}
								onChange={(event) => setNotes(event.target.value)}
								rows={3}
							/>
							<div className="plan-review-note-actions">
								<button type="button" className="plan-review-button" onClick={() => setNotes(null)}>
									{t("goalCancel")}
								</button>
								<button
									type="button"
									className="plan-review-button approve"
									id="planSendChanges"
									disabled={busy || !notes.trim()}
									onClick={() => void send(`${t("planChangePrefix")}\n\n${notes.trim()}`)}
								>
									{t("planSendChanges")}
								</button>
							</div>
						</div>
					)}
				</footer>
			) : null}
		</section>
	);
}

/** The proposal's opening paragraph, or its first lines when it has none. */
function firstParagraph(contents: string): string {
	const blocks = contents
		.split(/\n\s*\n/u)
		.map((block) => block.replace(/^#+\s*/u, "").trim())
		.filter(Boolean);
	return blocks[0] ?? contents.trim();
}
