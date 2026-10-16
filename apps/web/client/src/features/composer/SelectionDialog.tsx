/**
 * `#selectionDialog`: a kernel `ui.select` question the host relayed
 * (apps/web/src/selection.ts). Today that is the Full Access risk
 * acknowledgment raised by `/permissions full-access`, or by a session that
 * starts on a persisted Full Access tier.
 *
 * The kernel owns the question and parses the answer: the dialog sends back one
 * of the offered labels verbatim, or nothing for "dismissed", which the kernel
 * reads as "keep the previous tier". The Full Access question is recognised by
 * its exact option labels only to show translated copy; any other question, or
 * a future rewording, is shown as the kernel wrote it.
 *
 * Escape dismisses through the shell's central chain (ShellEffects), like
 * every other overlay. A backdrop click does nothing: a risk prompt should not
 * close from a stray click. Mounted by App.tsx next to the other modals, so the
 * fixed overlay is never inside the composer's stacking context.
 */

import "./selection-dialog.css";

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { type TranslateFn, useT } from "../../i18n";
import { FULL_ACCESS_RISK_OPTIONS, isFullAccessRisk } from "../../lib/permissions";
import { useAppStore } from "../../state/store";
import type { SelectionRequest } from "../../state/types";
import { Button, Icon, IconButton, Modal } from "../../ui";
import { answerSelection, pendingSelection } from "./actions";

interface PresentedOption {
	readonly value: string;
	readonly title: string;
	readonly description?: string;
}

interface Presented {
	readonly title: string;
	readonly message: string;
	readonly options: readonly PresentedOption[];
	/** A grant of elevated permission: warning styling on the header and confirm button. */
	readonly risky: boolean;
}

function present(request: SelectionRequest, t: TranslateFn): Presented {
	if (isFullAccessRisk(request)) {
		const [session = "", always = ""] = FULL_ACCESS_RISK_OPTIONS;
		return {
			title: t("fullAccessRiskTitle"),
			message: t("fullAccessRiskMessage"),
			risky: true,
			// The kernel's own "Cancel" row is the dialog's Cancel button: a dismissed
			// dialog is the same answer, and two cancels side by side read as a choice.
			options: [
				{ value: session, title: t("fullAccessRiskSession"), description: t("fullAccessRiskSessionDesc") },
				{ value: always, title: t("fullAccessRiskAlways"), description: t("fullAccessRiskAlwaysDesc") },
			],
		};
	}
	// Kernel convention: "Title\n\nmessage" and "Label — explanation".
	const [title = "", ...message] = request.title.split("\n\n");
	return {
		title,
		message: message.join("\n\n"),
		risky: false,
		options: request.options.map((option) => {
			const [label = option, ...description] = option.split(" — ");
			return { value: option, title: label, description: description.join(" — ") || undefined };
		}),
	};
}

/** Tab cycles within the dialog; only the selected option row is a tab stop. */
function trapTab(event: KeyboardEvent<HTMLElement>): void {
	if (event.key !== "Tab") return;
	const stops = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")].filter(
		(button) => button.tabIndex >= 0,
	);
	const first = stops[0];
	const last = stops[stops.length - 1];
	if (!first || !last) return;
	if (event.shiftKey && document.activeElement === first) {
		event.preventDefault();
		last.focus();
	} else if (!event.shiftKey && document.activeElement === last) {
		event.preventDefault();
		first.focus();
	}
}

export function SelectionDialog() {
	const request = useAppStore((state) => pendingSelection(state));
	return (
		<Modal
			id="selectionDialog"
			className="selection-dialog"
			open={Boolean(request)}
			labelledBy="selectionDialogTitle"
			closeOnBackdrop={false}
			dialogProps={{
				"aria-describedby": "selectionDialogMessage",
				...(request && isFullAccessRisk(request) ? { "data-risky": "true" } : {}),
				onKeyDown: trapTab,
			}}
		>
			{request ? <SelectionBody key={request.id} request={request} /> : null}
		</Modal>
	);
}

function SelectionBody({ request }: { readonly request: SelectionRequest }) {
	const t = useT();
	const view = present(request, t);
	const [index, setIndex] = useState(0);
	const [busy, setBusy] = useState(false);
	const listRef = useRef<HTMLDivElement>(null);
	const selected = view.options[index];

	useEffect(() => {
		const previous = document.activeElement;
		return () => {
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
			else document.getElementById("prompt")?.focus();
		};
	}, []);
	useEffect(() => {
		listRef.current?.querySelectorAll<HTMLButtonElement>("[role=option]")[index]?.focus();
	}, [index]);

	const submit = async (value: string | undefined) => {
		if (busy) return;
		setBusy(true);
		if (!(await answerSelection(request, value))) setBusy(false);
	};
	/** Arrow keys move the selection; Enter on an option confirms it. */
	const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
		const count = view.options.length;
		if (!count) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			setIndex((current) => (current + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
		} else if (event.key === "Enter" && selected) {
			event.preventDefault();
			void submit(selected.value);
		}
	};

	return (
		<>
			<header>
				{view.risky ? (
					<span className="selection-dialog-badge">
						<Icon name="shield" size="md" />
					</span>
				) : null}
				<h2 id="selectionDialogTitle">{view.title}</h2>
				<IconButton
					icon="close"
					aria-label={t("selectionDismiss")}
					disabled={busy}
					onClick={() => void submit(undefined)}
				/>
			</header>
			{view.message ? <p id="selectionDialogMessage">{view.message}</p> : null}
			<div
				className="selection-dialog-options"
				role="listbox"
				aria-labelledby="selectionDialogTitle"
				tabIndex={-1}
				ref={listRef}
				onKeyDown={onListKey}
			>
				{view.options.map((option, position) => (
					<button
						key={option.value}
						type="button"
						role="option"
						className="selection-dialog-option"
						aria-selected={position === index ? "true" : "false"}
						tabIndex={position === index ? 0 : -1}
						disabled={busy}
						onClick={() => setIndex(position)}
						onDoubleClick={() => void submit(option.value)}
					>
						<span className="selection-dialog-option-body">
							<span className="selection-dialog-option-title">{option.title}</span>
							{option.description ? (
								<span className="selection-dialog-option-desc">{option.description}</span>
							) : null}
						</span>
						{position === index ? <Icon name="check" size="sm" className="selection-dialog-check" /> : null}
					</button>
				))}
			</div>
			<footer>
				<Button id="selectionDialogCancel" disabled={busy} onClick={() => void submit(undefined)}>
					{t("cancel")}
				</Button>
				<Button
					id="selectionDialogConfirm"
					disabled={busy || !selected}
					onClick={() => {
						if (selected) void submit(selected.value);
					}}
				>
					{view.risky ? t("fullAccessRiskConfirm") : t("selectionConfirm")}
				</Button>
			</footer>
		</>
	);
}
