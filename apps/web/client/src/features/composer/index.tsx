/**
 * Composer feature slot, mounted by App.tsx inside `.composer-zone`:
 * `form#composer.composer` (legacy index.html 847-1007, app.js 2354-2985,
 * 3256-3273, 3508-3549, 3576-3583, 3818-3885).
 */

import "./composer.css";

import { type FormEvent, type ReactNode, useCallback, useRef, useState } from "react";
import { useT } from "../../i18n";
import { interruptCurrent } from "../../state/session";
import { getState, setUi, useAppStore } from "../../state/store";
import { Icon } from "../../ui";
import { AttachControls, AttachmentList } from "./Attachments";
import { sendMessage } from "./actions";
import { ClarificationPanel } from "./ClarificationPanel";
import { ModelMenu } from "./ModelMenu";
import { ModeMenu } from "./ModeMenu";
import { PolicyMenu } from "./PolicyMenu";
import { PromptInput } from "./PromptInput";
import {
	placeCaretAtEnd,
	promptFiles,
	promptText,
	restorePrompt,
	setPromptText,
	snapshotPrompt,
	waitForUploads,
} from "./prompt-editor";
import { type SlashItem, SlashMenu, type SlashMenuHandle, slashQuery } from "./SlashMenu";
import { UsageMenu } from "./UsageMenu";

export { ImagePreview } from "./ImagePreview";
export { SelectionDialog } from "./SelectionDialog";

export interface ComposerProps {
	/**
	 * `#workspaceControl` from the workspace feature: a compact folder pill just
	 * above `.composer-card`, outside it. App passes it in so the composer does
	 * not import the workspace feature.
	 */
	readonly workspaceControl?: ReactNode;
}

/** The three listbox popovers; only one is open at a time (legacy `setupPopover` `open()`). */
type ComposerMenu = "policy" | "mode" | "model";

export function Composer({ workspaceControl }: ComposerProps) {
	const t = useT();
	const form = useRef<HTMLFormElement | null>(null);
	const prompt = useRef<HTMLDivElement | null>(null);
	const [openMenu, setOpenMenu] = useState<ComposerMenu | null>(null);
	const [query, setQuery] = useState<string | null>(null);
	const slash = useRef<SlashMenuHandle | null>(null);
	const status = useAppStore((state) => state.current?.status);
	const waiting = status === "waiting";
	/*
	 * Whether `#prompt` holds text to send. While a turn runs, `#sendButton` is the stop button
	 * until the user types; then it sends (steers) again. Edits that bypass `input`
	 * (`setPromptText`, `restorePrompt`) call `syncHasText` themselves.
	 */
	const [hasText, setHasText] = useState(false);
	const syncHasText = () => setHasText(Boolean(prompt.current && promptText(prompt.current).trim()));
	const stopMode = status === "running" && !hasText;

	const menu = (name: ComposerMenu) => ({
		open: openMenu === name,
		onOpen: () => setOpenMenu(name),
		onClose: () => setOpenMenu((value) => (value === name ? null : value)),
	});

	const onValueInput = (value: string) => {
		setHasText(Boolean(value.trim()));
		const next = slashQuery(value);
		setQuery(next);
		const view = getState().ui.slashMenu;
		if (next !== null) setUi({ slashMenu: "commands" });
		else if (view) setUi({ slashMenu: null });
	};

	const pickSlash = useCallback((item: SlashItem) => {
		const editor = prompt.current;
		if (!editor) return;
		setQuery(null);
		if (item.kind === "mcp") {
			// A status view, not a prompt: nothing is sent.
			setPromptText(editor, "");
			setHasText(false);
			setUi({ slashMenu: "mcp" });
		} else {
			// The kernel runs `/<command> [args]` and expands `/skill:<name> [request]`
			// into the skill's instructions on send.
			setPromptText(editor, item.kind === "command" ? `/${item.key} ` : `/skill:${item.key} `);
			setHasText(true);
			setUi({ slashMenu: null });
		}
		editor.focus();
		placeCaretAtEnd(editor);
	}, []);

	/** True from Enter until the prompt is cleared, so a second Enter while uploads finish sends nothing. */
	const sending = useRef(false);
	const submit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const editor = prompt.current;
		if (!editor || sending.current) return;
		sending.current = true;
		try {
			// A chip has its upload id only once its upload settles; a failed one is removed.
			await waitForUploads();
			const text = promptText(editor).trim();
			const files = promptFiles(editor);
			if (!text) return;
			setQuery(null);
			setUi({ slashMenu: null });
			const draft = snapshotPrompt(editor);
			setPromptText(editor, "");
			setHasText(false);
			if (!(await sendMessage(text, files))) {
				restorePrompt(editor, draft);
				syncHasText();
			}
		} finally {
			sending.current = false;
		}
	};

	return (
		<form className="composer" id="composer" ref={form} onSubmit={(event) => void submit(event)}>
			<SlashMenu handle={slash} query={query} promptRef={prompt} onPick={pickSlash} />
			<ClarificationPanel />
			{workspaceControl}
			<div className="composer-card">
				<AttachmentList />
				<PromptInput
					promptRef={prompt}
					disabled={waiting}
					onSubmit={() => form.current?.requestSubmit()}
					onValueInput={onValueInput}
					onMenuKey={(key) => slash.current?.key(key) ?? false}
				/>
				<div className="composer-controls">
					<AttachControls />
					<PolicyMenu {...menu("policy")} />
					<ModeMenu {...menu("mode")} />
					<div className="composer-right">
						<UsageMenu />
						<ModelMenu {...menu("model")} />
						{stopMode ? (
							<button
								className="send-button send-button--stop"
								id="stopRun"
								type="button"
								title={t("stopRun")}
								aria-label={t("stopRun")}
								onClick={() => void interruptCurrent()}
							>
								<Icon name="stop" />
							</button>
						) : (
							<button
								className="send-button"
								id="sendButton"
								type="submit"
								title={t("sendMessage")}
								aria-label={t("sendMessage")}
								disabled={waiting}
							>
								<Icon name="send" />
							</button>
						)}
					</div>
				</div>
			</div>
		</form>
	);
}
