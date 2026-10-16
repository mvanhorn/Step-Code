/**
 * The kernel's Full Access risk question, as the host relays it
 * (`FULL_ACCESS_RISK_*` in packages/coding-agent/src/step/permissions.ts).
 *
 * The client imports no kernel code, so these labels are mirrored here. They
 * are used only to recognise the question (to show translated copy) and to ask
 * it for a draft before its session exists; the answer always travels back as
 * one of these labels, which the kernel parses itself. If the kernel rewords
 * them, the dialog falls back to showing the kernel's text and a draft simply
 * lets the kernel ask again.
 */

import type { SelectionRequest } from "../state/types";

export const FULL_ACCESS_PRESET = "full-access";

export const FULL_ACCESS_RISK_TITLE =
	"Enable full access?\n\nWhen Step runs with full access, it can edit any file on your computer and run commands with network, without your approval. Exercise caution when enabling full access. This significantly increases the risk of data loss, leaks, or unexpected behavior.";

/** In the kernel's order: this session, don't ask again, cancel. */
export const FULL_ACCESS_RISK_OPTIONS: readonly string[] = [
	"Yes, continue anyway — apply full access for this session",
	"Yes, and don't ask again — enable full access and remember this choice",
	"Cancel — go back without enabling full access",
];

export const FULL_ACCESS_RISK_CANCEL = "Cancel — go back without enabling full access";

/** Id of the question a draft asks locally; it never reaches the host. */
export const DRAFT_SELECTION_ID = "draft-full-access";

export function isFullAccessRisk(request: SelectionRequest): boolean {
	return (
		request.options.length === FULL_ACCESS_RISK_OPTIONS.length &&
		FULL_ACCESS_RISK_OPTIONS.every((option, index) => request.options[index] === option)
	);
}

/** The question a draft asks when Full Access is picked before its session exists. */
export function draftFullAccessQuestion(): SelectionRequest {
	return {
		id: DRAFT_SELECTION_ID,
		sessionId: "",
		title: FULL_ACCESS_RISK_TITLE,
		options: FULL_ACCESS_RISK_OPTIONS,
	};
}
