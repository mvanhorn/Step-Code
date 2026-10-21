/**
 * Desktop sign-in. The host writes `~/.stepcode/auth.json` (the file `step
 * login` writes); this module only drives its routes and closes the gate.
 */

import { ApiError, api, apiSend, errorMessage } from "../../lib/api";
import { getDesktopBridge } from "../../platform/host";
import { completeLogin, continueWithoutLogin } from "../../state/session";
import type { BrowserLoginState, LoginMethod, LoginReport } from "../../state/types";
import { openSettings } from "../settings/actions";

const BROWSER_POLL_MS = 1500;

export async function loadLoginMethods(): Promise<readonly LoginMethod[]> {
	return (await api<{ methods: LoginMethod[] }>("/api/v1/login/methods")).methods;
}

/**
 * Skip the Step sign-in and bring your own key: close the gate, let the app
 * start, and open the models page where custom endpoints are configured.
 */
export function continueWithOwnModels(): void {
	continueWithoutLogin();
	openSettings("models");
}

/** Open a page in the system browser (Desktop), or a new tab in a plain browser. */
export function openLoginPage(url: string): void {
	const bridge = getDesktopBridge();
	if (bridge) {
		void bridge.openExternal(url).catch(() => window.open(url, "_blank", "noopener,noreferrer"));
		return;
	}
	window.open(url, "_blank", "noopener,noreferrer");
}

async function finishLogin(signal?: AbortSignal): Promise<void> {
	const login = await api<LoginReport>("/api/v1/login", { signal });
	if (!signal?.aborted) completeLogin(login);
}

export type ApiKeyOutcome =
	| { readonly kind: "ok"; readonly warning?: string }
	| { readonly kind: "invalid" }
	| { readonly kind: "unavailable" }
	| { readonly kind: "error"; readonly message: string };

/** Validate and save a platform key; the gate closes when it is accepted. */
export async function signInWithApiKey(
	profile: LoginMethod["id"],
	apiKey: string,
	signal?: AbortSignal,
): Promise<ApiKeyOutcome> {
	try {
		const result = await api<{ login: LoginReport; warning?: string }>("/api/v1/login/api-key", {
			method: "POST",
			body: JSON.stringify({ profile, apiKey }),
			signal,
		});
		if (!signal?.aborted) completeLogin(result.login);
		return { kind: "ok", ...(result.warning ? { warning: result.warning } : {}) };
	} catch (caught) {
		if (caught instanceof ApiError && caught.body.code === "invalid_key") return { kind: "invalid" };
		if (caught instanceof ApiError && caught.body.code === "unavailable") return { kind: "unavailable" };
		return { kind: "error", message: errorMessage(caught) };
	}
}

/** Bumped by every start and cancel, so a stale poll loop stops on its own. */
let browserAttempt = 0;
let browserStart: Promise<BrowserLoginState> | undefined;
let browserCancellation: Promise<void> = Promise.resolve();

export interface BrowserSignInOutcome {
	readonly outcome: "completed" | "cancelled";
	/** Non-fatal account-session problem; the credential is already saved. */
	readonly warning?: string;
}

/**
 * Step Plan sign-in: the host starts the same cloud flow as `step login` and
 * hands back the authorize URL, which opens in the system browser. Resolves
 * `completed` after the approval is saved, `cancelled` when the user went back;
 * throws when the sign-in fails.
 */
export async function signInWithBrowser(
	profile: LoginMethod["id"],
	onAuthUrl: (url: string) => void,
	signal?: AbortSignal,
): Promise<BrowserSignInOutcome> {
	browserAttempt += 1;
	const attempt = browserAttempt;
	try {
		await browserCancellation;
		if (attempt !== browserAttempt || signal?.aborted) return { outcome: "cancelled" };
		const pending = apiSend<BrowserLoginState>("/api/v1/login/browser", "POST", { profile });
		browserStart = pending;
		const started = await pending;
		if (browserStart === pending) browserStart = undefined;
		if (attempt !== browserAttempt || signal?.aborted) return { outcome: "cancelled" };
		if (started.state === "failed") throw new Error(started.error ?? "failed");
		if (started.authUrl) {
			onAuthUrl(started.authUrl);
			openLoginPage(started.authUrl);
		}
		for (;;) {
			await new Promise((resolve) => setTimeout(resolve, BROWSER_POLL_MS));
			if (attempt !== browserAttempt || signal?.aborted) return { outcome: "cancelled" };
			const state = await api<BrowserLoginState>("/api/v1/login/browser", { signal });
			if (attempt !== browserAttempt || signal?.aborted) return { outcome: "cancelled" };
			if (state.state === "completed") {
				await finishLogin(signal);
				return { outcome: "completed", ...(state.warning ? { warning: state.warning } : {}) };
			}
			if (state.state === "failed") throw new Error(state.error ?? "failed");
			if (state.state === "idle") return { outcome: "cancelled" };
		}
	} catch (caught) {
		// After the user went back, a late failure is not theirs to see.
		if (attempt !== browserAttempt || signal?.aborted) return { outcome: "cancelled" };
		throw caught;
	}
}

export function cancelBrowserSignIn(): void {
	browserAttempt += 1;
	// Best effort: if this request is lost, the host's sign-in still ends at its
	// own timeout, and the poll loop above has already stopped.
	// Serialize cleanup after an in-flight start and before the next start:
	// a slow DELETE must never cancel a replacement authorization.
	browserCancellation = Promise.allSettled([browserCancellation, browserStart]).then(async () => {
		await apiSend("/api/v1/login/browser", "DELETE").catch(() => {});
	});
}
