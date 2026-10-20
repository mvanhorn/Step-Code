/**
 * Shell actions with fixed names, callable from any feature. The shell feature
 * owns this file; legacy app.js line numbers are noted per function.
 */

import type { Locale } from "../../i18n/messages";
import { api, errorMessage } from "../../lib/api";
import { STORAGE_KEYS, writeStorage } from "../../lib/storage";
import { closeStream, showError } from "../../state/session";
import { getState, setState, setUi, type ThemeChoice } from "../../state/store";
import type { LoginReport } from "../../state/types";

const THEMES: readonly ThemeChoice[] = ["system", "light", "dark"];

/**
 * Where "Upgrade" leads: the Step Plan page of the signed-in account's
 * platform, which the host derives from the stored profile (overseas accounts
 * use platform.stepfun.ai). The mainland page stands in until bootstrap answers.
 */
export function stepPlanUrl(login: LoginReport | null): string {
	return login?.planUrl ?? "https://platform.stepfun.com/step-plan";
}

function systemPrefersDark(): boolean {
	return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

/** "light" or "dark" for a theme choice (legacy `resolvedTheme`, 524-526). */
export function resolvedTheme(theme: ThemeChoice = getState().theme): "light" | "dark" {
	return theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;
}

/**
 * Apply and (by default) persist a theme choice (legacy `applyTheme`, 559-564).
 * Writes `<html data-theme>` directly so the first paint is already themed.
 * Settings controls re-render from the store.
 */
export function applyTheme(theme: string, persist = true): void {
	const next: ThemeChoice = THEMES.includes(theme as ThemeChoice) ? (theme as ThemeChoice) : "system";
	setState({ theme: next });
	document.documentElement.dataset.theme = resolvedTheme(next);
	if (persist) writeStorage(STORAGE_KEYS.theme, next);
}

/**
 * Apply and (by default) persist a locale (legacy `applyLocale`, 566-601).
 * Re-translating the page is automatic: components read the locale from the store.
 */
export function applyLocale(locale: string, persist = true): void {
	const next: Locale = locale === "en-US" ? "en-US" : "zh-CN";
	setState({ locale: next });
	document.documentElement.lang = next;
	if (persist) writeStorage(STORAGE_KEYS.locale, next);
}

/** Show or hide the sidebar (legacy `.app.classList.toggle("sidebar-hidden")`, 3383-3388, 3627). */
export function toggleSidebar(): void {
	setUi((ui) => ({ sidebarHidden: !ui.sidebarHidden }));
}

/** Ask before logging out: opens `#logoutDialog`, which calls `confirmLogout`. */
export function logout(): void {
	setUi({ logoutConfirm: { pending: false } });
}

/** Cancel the log-out dialog; ignored while the request is in flight. */
export function closeLogoutConfirm(): void {
	if (!getState().ui.logoutConfirm?.pending) setUi({ logoutConfirm: null });
}

/**
 * Log out, close the live stream and cover the page with the logged-out
 * overlay (legacy `logout`, 3233-3243). A failure keeps the dialog open, so
 * the user can retry or cancel.
 */
export async function confirmLogout(): Promise<void> {
	if (getState().ui.logoutConfirm?.pending) return;
	setUi({ logoutConfirm: { pending: true } });
	try {
		await api("/auth/logout", { method: "POST", body: "{}" });
		closeStream();
		setUi({ logoutConfirm: null, loggedOut: true, settingsPage: null, settingsEditor: null, settingsDialog: null });
	} catch (error) {
		setUi({ logoutConfirm: { pending: false } });
		showError(errorMessage(error));
	}
}

/**
 * Follow the OS theme while the choice is "system" (legacy 3647-3649).
 * Returns the cleanup function.
 */
export function watchSystemTheme(): () => void {
	if (typeof matchMedia !== "function") return () => {};
	const query = matchMedia("(prefers-color-scheme: dark)");
	const onChange = () => {
		if (getState().theme === "system") applyTheme("system", false);
	};
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
}
