/**
 * Document-level listeners owned by the shell: the global keyboard shortcuts
 * and the central Escape chain (legacy app.js 3599-3644), and the OS theme
 * listener (3647-3649). Renders nothing.
 */

import { useEffect } from "react";
import { activeCwd, interruptCurrent } from "../../state/session";
import { getState, setUi } from "../../state/store";
import { answerSelection, pendingSelection } from "../composer/actions";
import { openTree, setPreviewOpen } from "../files/actions";
import { closeTopmostSettingsLayer } from "../settings/actions";
import { closeSearch, closeWorkspaceMenu, openSearch } from "../sidebar/actions";
import { chooseWorkspaceFolder, closeWorkspaceRemoval } from "../workspace/actions";
import { closeLogoutConfirm, confirmLogout, toggleSidebar, watchSystemTheme } from "./actions";

/**
 * Escape closes the topmost overlay, first match only, and otherwise stops the
 * running turn (legacy 3631-3643). Overlays in this chain do not close
 * themselves on Escape. State is read at key time, so an overlay that an
 * earlier (React) handler just closed is skipped, exactly as the legacy chain
 * saw it already hidden.
 */
function handleEscape(): void {
	const state = getState();
	const { ui } = state;
	// A kernel question blocks its session and sits above everything else;
	// Escape dismisses it, which the kernel reads as "cancel".
	const selection = pendingSelection(state);
	if (selection) void answerSelection(selection, undefined);
	else if (ui.logoutConfirm) closeLogoutConfirm();
	else if (ui.imagePreview) setUi({ imagePreview: null });
	else if (ui.accountMenuOpen) setUi({ accountMenuOpen: false });
	else if (ui.workspaceRemoval) closeWorkspaceRemoval();
	else if (ui.slashMenu) setUi({ slashMenu: null });
	else if (ui.changesMenu) setUi({ changesMenu: null });
	else if (ui.searchOpen) closeSearch();
	else if (ui.workspaceBrowserOpen) setUi({ workspaceBrowserOpen: false });
	else if (closeTopmostSettingsLayer()) return;
	else if (ui.workspacePopoverOpen) setUi({ workspacePopoverOpen: false });
	else if (ui.tagPicker) setUi({ tagPicker: null });
	else if (ui.workspaceMenu) closeWorkspaceMenu(true);
	else if (ui.sessionMenu) setUi({ sessionMenu: null });
	else if (ui.fileTreeOpen) setUi({ fileTreeOpen: false });
	else if (ui.midView) setUi({ midView: null });
	else if (ui.childView) setUi({ childView: null });
	else void interruptCurrent();
}

function handleKeydown(event: KeyboardEvent): void {
	// The sign-in gate cannot be dismissed, and nothing behind it may act.
	if (getState().ui.loginRequired) return;
	const mod = event.metaKey || event.ctrlKey;
	// Autofill and some IMEs dispatch keydown without a `key`.
	const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
	// The log-out dialog's ↵ hint holds wherever focus is (it can land on the
	// page behind, e.g. after a click on the dialog text). A focused dialog
	// button keeps its own Enter, so Enter on Cancel still cancels.
	if (event.key === "Enter" && !event.isComposing && !mod && getState().ui.logoutConfirm) {
		const target = event.target;
		if (!(target instanceof HTMLButtonElement && target.closest("#logoutDialog"))) {
			event.preventDefault();
			void confirmLogout();
		}
		return;
	}
	// With Alt held, macOS reports the composed character in `key`, so the
	// Alt chords match on the physical key instead.
	if (mod && event.altKey && event.code === "KeyO") {
		event.preventDefault();
		void chooseWorkspaceFolder();
		return;
	}
	if (mod && event.altKey && event.code === "KeyP") {
		event.preventDefault();
		const cwd = activeCwd();
		if (cwd) void openTree({ cwd });
		return;
	}
	if (mod && key === "b") {
		event.preventDefault();
		if (event.shiftKey) {
			const { preview } = getState();
			if (preview.tabs.length || preview.changes) setPreviewOpen(!preview.open);
		} else toggleSidebar();
	}
	if (mod && key === "k") {
		event.preventDefault();
		openSearch();
	}
	if (event.key === "Escape") handleEscape();
}

export function ShellEffects() {
	useEffect(() => {
		document.addEventListener("keydown", handleKeydown);
		return () => document.removeEventListener("keydown", handleKeydown);
	}, []);
	useEffect(() => watchSystemTheme(), []);
	return null;
}
