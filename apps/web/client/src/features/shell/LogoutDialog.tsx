/**
 * `#logoutDialog`: the in-app confirmation for Log out (settings page, account
 * menu), in place of the browser's `window.confirm`. Focus starts on the
 * confirm button. Enter confirms and Escape cancels, both from the shell's key
 * handler, so they work wherever focus is.
 */

import { useEffect, useRef } from "react";
import { useT } from "../../i18n";
import { useAppStore } from "../../state/store";
import { Button, Kbd, Modal } from "../../ui";
import { closeLogoutConfirm, confirmLogout } from "./actions";

export function LogoutDialog() {
	const t = useT();
	const confirm = useAppStore((state) => state.ui.logoutConfirm);
	const confirmRef = useRef<HTMLButtonElement>(null);
	const open = confirm !== null;
	const pending = confirm?.pending ?? false;
	useEffect(() => {
		if (!open) return;
		const previous = document.activeElement;
		confirmRef.current?.focus();
		return () => {
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
		};
	}, [open]);
	return (
		<Modal
			id="logoutDialog"
			className="logout-dialog"
			open={open}
			labelledBy="logoutDialogTitle"
			onClose={closeLogoutConfirm}
			dialogProps={{
				"aria-describedby": "logoutDialogDescription",
				"aria-busy": pending,
				onKeyDown: (event) => {
					// Keep Tab between the two buttons while the dialog is open.
					if (event.key !== "Tab") return;
					const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
					const first = buttons[0];
					const last = buttons[buttons.length - 1];
					if (!first || !last) {
						event.preventDefault();
					} else if (event.shiftKey && document.activeElement === first) {
						event.preventDefault();
						last.focus();
					} else if (!event.shiftKey && document.activeElement === last) {
						event.preventDefault();
						first.focus();
					}
				},
			}}
		>
			<h2 id="logoutDialogTitle">{t("logoutDialogTitle")}</h2>
			<p id="logoutDialogDescription">{t("logoutDialogDescription")}</p>
			<footer>
				<Button id="logoutCancel" disabled={pending} onClick={closeLogoutConfirm}>
					<span>{t("cancel")}</span>
					<Kbd bare className="logout-dialog-key" aria-hidden="true">
						esc
					</Kbd>
				</Button>
				<Button ref={confirmRef} id="logoutConfirm" disabled={pending} onClick={() => void confirmLogout()}>
					<span>{t("logout")}</span>
					<Kbd bare className="logout-dialog-key" aria-hidden="true">
						↵
					</Kbd>
				</Button>
			</footer>
		</Modal>
	);
}
