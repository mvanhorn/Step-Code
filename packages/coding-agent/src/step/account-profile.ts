/**
 * The signed-in account's display profile (nickname and avatar).
 *
 * Built on the stored account session: `getStepLoginToken` hands out a fresh
 * access token (refreshing it when needed), and the developer center's
 * `UserInfo` call answers who that token belongs to. Hosts show the result next
 * to the account; nothing here affects model requests, which keep using the
 * API key.
 */

import { fetchStepUserInfo, StepUserInfoError } from "@step-harness/providers/step-provider";
import { getStepLoginToken, resolveStepLoginAuthBaseUrl, type StepLoginTokenOptions } from "./login-state.ts";
import type { StepLoginProfileId } from "./onboarding.ts";

export interface StepAccountProfile {
	/** What to show as the account's name: nickname, else email, else phone. */
	readonly name: string;
	readonly avatarUrl?: string;
	readonly uid?: string;
	/** Login region the session belongs to. */
	readonly profile: StepLoginProfileId;
}

export type StepAccountProfileOutcome =
	| { readonly status: "ready"; readonly account: StepAccountProfile }
	/** No account session is stored (API-key sign-in, or a backend without sessions). */
	| { readonly status: "missing" }
	/** The session is gone or rejected; only a new sign-in recovers. */
	| { readonly status: "expired"; readonly reason: string }
	/** Transient failure; asking again later may work. */
	| { readonly status: "unavailable"; readonly reason: string };

/**
 * Look up the signed-in account's profile with the stored session.
 *
 * A rejected session is reported as `expired` but left on disk: only the
 * refresh path, which has a positive "signed out" signal, deletes it. A 401 here
 * may be a gateway answer, and costing the user their session on a guess is
 * worse than asking again.
 */
export async function getStepAccountProfile(options: StepLoginTokenOptions = {}): Promise<StepAccountProfileOutcome> {
	const env = options.env ?? process.env;
	const token = await getStepLoginToken(options);
	if (token.status !== "ready") return token;
	try {
		const info = await fetchStepUserInfo({
			authBaseUrl: resolveStepLoginAuthBaseUrl(token.profile, env),
			accessToken: token.accessToken,
			refreshToken: token.refreshToken,
			appId: token.appId,
			deviceId: token.deviceId,
			...(options.signal ? { signal: options.signal } : {}),
			...(options.fetch ? { fetch: options.fetch } : {}),
		});
		const name = info.nickname ?? info.email ?? info.mobile;
		if (!name) return { status: "unavailable", reason: "the account profile has no display name" };
		return {
			status: "ready",
			account: {
				name,
				...(info.avatarUrl ? { avatarUrl: info.avatarUrl } : {}),
				...(info.uid ? { uid: info.uid } : {}),
				profile: token.profile,
			},
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		if (error instanceof StepUserInfoError && error.failure === "unauthenticated") {
			return { status: "expired", reason };
		}
		return { status: "unavailable", reason };
	}
}
