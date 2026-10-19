/**
 * Composer state changes, ported from legacy app.js. Each function updates the
 * store (and the server); the composer components re-render from the store.
 */

import { t } from "../../i18n";
import { api, apiSend, errorMessage } from "../../lib/api";
import {
	DRAFT_SELECTION_ID,
	draftFullAccessQuestion,
	FULL_ACCESS_PRESET,
	FULL_ACCESS_RISK_CANCEL,
} from "../../lib/permissions";
import {
	countUserMessages,
	createSessionIfNeeded,
	forgetSelection,
	renderSnapshot,
	showError,
} from "../../state/session";
import { type AppState, getState, type ModeId, setState } from "../../state/store";
import type {
	Attachment,
	ClarificationReply,
	ClarificationRequest,
	SelectionRequest,
	SessionSnapshot,
	UploadedFile,
} from "../../state/types";
import type { PromptFile } from "./prompt-editor";

export async function replyToClarification(
	request: ClarificationRequest,
	answers: readonly ClarificationReply[],
	cancelled = false,
): Promise<boolean> {
	try {
		await apiSend(`/api/v1/sessions/${request.sessionId}/clarifications/response`, "POST", {
			id: request.id,
			answers,
			cancelled,
		});
		return true;
	} catch (error) {
		showError(errorMessage(error));
		return false;
	}
}

/* ── Permission policy (legacy renderPolicies onSelect 2534-2541, `policychange` 3509-3522) ── */

/**
 * Make `preset` the draft policy and, with a session open, apply it there.
 *
 * Full Access needs the risk acknowledgment first. A live session's kernel
 * asks it (the PATCH returns with the question pending and the tier
 * unchanged). A draft has no kernel yet, so it asks the same question itself
 * and keeps the answer for the session it creates on the first send.
 */
export async function selectPolicy(preset: string): Promise<void> {
	const state = getState();
	const current = state.current;
	if (!current) {
		if (preset === FULL_ACCESS_PRESET && preset !== state.draftPolicy && !state.draftModels?.fullAccessAcknowledged) {
			setState({ draftSelection: draftFullAccessQuestion() });
			return;
		}
		setState({ draftPolicy: preset, draftFullAccessAnswer: "", draftPolicyPicked: true });
		return;
	}
	setState({ draftPolicy: preset });
	try {
		renderSnapshot(await apiSend<SessionSnapshot>(`/api/v1/sessions/${current.id}/policy`, "PATCH", { preset }));
	} catch (error) {
		showError(errorMessage(error));
	}
}

/* ── Kernel selectors (the Full Access risk question) ─────────────────────── */

/** The question to show: the open session's, or the draft's own Full Access question. */
export function pendingSelection(state: AppState): SelectionRequest | undefined {
	return state.current ? state.current.pendingSelections?.[0] : (state.draftSelection ?? undefined);
}

const answeringSelections = new Set<string>();

/**
 * Answer a pending selection with one of its options, or `undefined` to
 * dismiss it. The host replies once the command that asked has applied the
 * answer, so the returned snapshot already shows the resulting permission tier.
 * The draft's own question is answered locally.
 */
export async function answerSelection(request: SelectionRequest, value: string | undefined): Promise<boolean> {
	if (request.id === DRAFT_SELECTION_ID) {
		const granted = value !== undefined && value !== FULL_ACCESS_RISK_CANCEL;
		setState(
			granted
				? {
						draftSelection: null,
						draftPolicy: FULL_ACCESS_PRESET,
						draftFullAccessAnswer: value,
						draftPolicyPicked: true,
					}
				: { draftSelection: null },
		);
		return true;
	}
	// Escape (ShellEffects) and the dialog's buttons can both answer; the second
	// would only earn a "not found" error.
	if (answeringSelections.has(request.id)) return false;
	answeringSelections.add(request.id);
	try {
		const snapshot = await apiSend<SessionSnapshot>(
			`/api/v1/sessions/${request.sessionId}/selections/response`,
			"POST",
			{ id: request.id, ...(value === undefined ? {} : { value }) },
		);
		forgetSelection(request.id);
		renderSnapshot(snapshot);
		return true;
	} catch (error) {
		showError(errorMessage(error));
		return false;
	} finally {
		answeringSelections.delete(request.id);
	}
}

/* ── Model and thinking effort (legacy selectModel / selectEffort, 2746-2776) ── */

/**
 * Apply a model (`${provider}\u0000${id}`). Resolves true when the panel should
 * repaint as legacy did: the server returned a new snapshot, or a draft
 * recorded the pick for the session its first send creates.
 */
export async function selectModel(value: string): Promise<boolean> {
	const [provider, modelId] = value.split("\u0000");
	setState({ draftModel: value });
	const current = getState().current;
	if (!current) return true;
	try {
		renderSnapshot(
			await apiSend<SessionSnapshot>(`/api/v1/sessions/${current.id}/model`, "PATCH", { provider, modelId }),
		);
		return true;
	} catch (error) {
		showError(errorMessage(error));
		return false;
	}
}

/** Apply a thinking level. Resolves true on success (the panel then closes); a draft keeps it for its first send. */
export async function selectEffort(level: string): Promise<boolean> {
	const current = getState().current;
	if (!current) {
		setState({ draftThinking: level });
		return true;
	}
	try {
		renderSnapshot(await apiSend<SessionSnapshot>(`/api/v1/sessions/${current.id}/thinking`, "PATCH", { level }));
		return true;
	} catch (error) {
		showError(errorMessage(error));
		return false;
	}
}

/* ── Session modes (legacy toggleMode, 2879-2903) ─────────────────────────── */

function setMode(id: ModeId, enabled: boolean): void {
	setState((state) => ({ modes: { ...state.modes, [id]: enabled } }));
}

/**
 * Flip one mode. Returns whether the mode panel should close: switching goal
 * on keeps it open so the goal can be typed, and sends nothing yet.
 */
export function toggleMode(id: ModeId): boolean {
	const next = !getState().modes[id];
	setMode(id, next);
	if (id === "goal" && next) return false;
	void sendModeToggle(id, next);
	return true;
}

async function sendModeToggle(id: ModeId, next: boolean): Promise<void> {
	const current = getState().current;
	if (!current) return;
	try {
		// The server accepts the toggle and runs the slash command in the
		// background, so there is no snapshot to render from the response.
		await apiSend(`/api/v1/sessions/${current.id}/mode`, "PATCH", {
			mode: id,
			enabled: next,
			goal: getState().goalDraft,
		});
		if (id === "goal" && next) setState({ goalDraft: "" });
	} catch (error) {
		setMode(id, !next);
		showError(errorMessage(error));
	}
}

/* ── Attachments (legacy 2919-2985) ──────────────────────────────────────── */

/** Attachments staged for the next message, cleared once it is sent. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

function readFileAsBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = String(reader.result);
			resolve(result.slice(result.indexOf(",") + 1));
		};
		reader.onerror = () => reject(reader.error ?? new Error(t("attachmentUnreadable")));
		reader.readAsDataURL(file);
	});
}

/** Read each file (up to 5 MB) and stage it; oversized or unreadable files raise a toast. */
export async function addAttachments(files: readonly File[]): Promise<void> {
	for (const file of files) {
		if (file.size > MAX_ATTACHMENT_BYTES) {
			showError(t("attachmentTooLarge"));
			continue;
		}
		try {
			const attachment: Attachment = {
				name: file.name,
				mimeType: file.type || "application/octet-stream",
				data: await readFileAsBase64(file),
				kind: file.type.startsWith("image/") ? "image" : "text",
			};
			setState((state) => ({ attachments: [...state.attachments, attachment] }));
		} catch (error) {
			showError((error instanceof Error && error.message) || t("attachmentUnreadable"));
		}
	}
}

/**
 * Copy a pasted or dropped file to the host, which answers with the path the
 * message will name. The browser never sees the file's original path.
 */
export function uploadFile(file: File): Promise<UploadedFile> {
	return api<UploadedFile>(`/api/v1/uploads?${new URLSearchParams({ name: file.name })}`, {
		method: "POST",
		body: file,
		headers: { "content-type": "application/octet-stream" },
	});
}

export function removeAttachment(index: number): void {
	setState((state) => ({ attachments: state.attachments.filter((_, position) => position !== index) }));
}

/* ── Sending (legacy `#composer` submit, 3523-3549) ──────────────────────── */

/**
 * Send `text` with the staged attachments, creating the session first when
 * this is a draft. The caller has already cleared the prompt; on failure the
 * attachments are restored here and false is returned so the caller can put
 * the text back.
 */
export async function sendMessage(text: string, files: readonly PromptFile[] = []): Promise<boolean> {
	// Attachments are sent with the message and dropped afterwards, so a failed
	// send has to put both back.
	const { attachments, current, timelineItems } = getState();
	// A message steered into a running turn waits for the current step, so only
	// a new turn gets the immediate message and thinking indicator.
	const pendingTurn =
		current?.status === "running" ? null : { text, files, userCount: countUserMessages(timelineItems) };
	setState({ attachments: [], pendingTurn });
	try {
		const session = await createSessionIfNeeded();
		const endpoint = session.status === "running" ? "steer" : "messages";
		await api(`/api/v1/sessions/${session.id}/${endpoint}`, {
			method: "POST",
			// `files`: upload ids of the prompt's file chips; the host adds their content.
			body: JSON.stringify({ text, attachments, files: files.map((file) => file.id) }),
		});
		return true;
	} catch (error) {
		setState({ attachments, pendingTurn: null });
		showError(errorMessage(error));
		return false;
	}
}
