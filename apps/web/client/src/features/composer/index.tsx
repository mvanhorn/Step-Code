/**
 * Composer feature slot, mounted by App.tsx inside `.composer-zone`:
 * `form#composer.composer` (legacy index.html 847-1007, app.js 2354-2985,
 * 3256-3273, 3508-3549, 3576-3583, 3818-3885).
 */

import "./composer.css";

import { type FormEvent, type ReactNode, useCallback, useRef, useState } from "react";
import { interruptCurrent } from "../../state/session";
import { getState, setUi, useAppStore } from "../../state/store";
import { Icon } from "../../ui";
import { AttachControls, AttachmentList } from "./Attachments";
import { sendMessage } from "./actions";
import { ClarificationPanel } from "./ClarificationPanel";
import { ModelMenu } from "./ModelMenu";
import { ModeMenu } from "./ModeMenu";
import { PolicyMenu } from "./PolicyMenu";
import { PromptInput, resizePrompt } from "./PromptInput";
import { type SlashItem, SlashMenu, type SlashMenuHandle, slashQuery } from "./SlashMenu";
import { UsageMenu } from "./UsageMenu";

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
	const form = useRef<HTMLFormElement | null>(null);
	const prompt = useRef<HTMLTextAreaElement | null>(null);
	const [openMenu, setOpenMenu] = useState<ComposerMenu | null>(null);
	const [query, setQuery] = useState<string | null>(null);
	const slash = useRef<SlashMenuHandle | null>(null);
	const status = useAppStore((state) => state.current?.status);
	const waiting = status === "waiting";

	const menu = (name: ComposerMenu) => ({
		open: openMenu === name,
		onOpen: () => setOpenMenu(name),
		onClose: () => setOpenMenu((value) => (value === name ? null : value)),
	});

	const onValueInput = (value: string) => {
		const next = slashQuery(value);
		setQuery(next);
		const view = getState().ui.slashMenu;
		if (next !== null) setUi({ slashMenu: "commands" });
		else if (view) setUi({ slashMenu: null });
	};

	const pickSlash = useCallback((item: SlashItem) => {
		const textarea = prompt.current;
		if (!textarea) return;
		setQuery(null);
		if (item.kind === "mcp") {
			// A status view, not a prompt: nothing is sent.
			textarea.value = "";
			setUi({ slashMenu: "mcp" });
		} else {
			// The kernel runs `/<command> [args]` and expands `/skill:<name> [request]`
			// into the skill's instructions on send.
			textarea.value = item.kind === "command" ? `/${item.key} ` : `/skill:${item.key} `;
			setUi({ slashMenu: null });
		}
		resizePrompt(textarea);
		textarea.focus();
		textarea.setSelectionRange(textarea.value.length, textarea.value.length);
	}, []);

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const textarea = prompt.current;
		if (!textarea) return;
		const text = textarea.value.trim();
		if (!text) return;
		setQuery(null);
		setUi({ slashMenu: null });
		textarea.value = "";
		resizePrompt(textarea);
		void sendMessage(text).then((sent) => {
			if (sent) return;
			textarea.value = text;
			resizePrompt(textarea);
		});
	};

	return (
		<form className="composer" id="composer" ref={form} onSubmit={submit}>
			<SlashMenu handle={slash} query={query} promptRef={prompt} onPick={pickSlash} />
			<ClarificationPanel />
			{workspaceControl}
			<div className="composer-card">
				<PromptInput
					promptRef={prompt}
					disabled={waiting}
					onSubmit={() => form.current?.requestSubmit()}
					onValueInput={onValueInput}
					onMenuKey={(key) => slash.current?.key(key) ?? false}
				/>
				<AttachmentList />
				<div className="composer-controls">
					<AttachControls />
					<PolicyMenu {...menu("policy")} />
					<ModeMenu {...menu("mode")} />
					<div className="composer-right">
						<UsageMenu />
						<ModelMenu {...menu("model")} />
						<button
							className="stop-button"
							type="button"
							id="stopRun"
							hidden={status !== "running"}
							onClick={() => void interruptCurrent()}
						>
							停止
						</button>
						<button
							className="send-button"
							id="sendButton"
							type="submit"
							title="发送"
							aria-label="发送"
							disabled={waiting}
						>
							<Icon name="send" />
						</button>
					</div>
				</div>
			</div>
		</form>
	);
}
