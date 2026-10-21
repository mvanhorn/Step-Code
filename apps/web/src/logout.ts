import { getLegacyStepAuthPath, logoutStepCredentials, syncStepLoginProfileEndpoint } from "@step-harness/coding-agent";

/** What a Step sign-out removed, and whether a credential still supplies requests. */
export interface StepLogoutOutcome {
	/** A stored `step` credential (or legacy Step credential) was removed. */
	readonly removed: boolean;
	/** The `step-login.json` account session is gone from disk. */
	readonly accountSessionRemoved: boolean;
	/** `environment` when `STEP_API_KEY` still authorizes requests after the sign-out. */
	readonly remainingSource: "environment" | null;
}

export interface StepLogoutOptions {
	readonly authPath: string;
	readonly legacyPath?: string;
	readonly env?: Record<string, string | undefined>;
	/**
	 * Stop the Host's in-flight sessions before the credential is removed.
	 *
	 * A running session keeps its model runtime in memory, so deleting
	 * `auth.json` alone would let the current turn finish with the old key.
	 * Stopping first makes sign-out an explicit interruption. A failure here is
	 * logged but does not keep the credential on disk.
	 */
	readonly stopSessions?: () => Promise<unknown>;
}

/**
 * Sign out exactly as `step logout` does: remove the stored credential, the
 * legacy copies, and `step-login.json`. The caller owns cache invalidation and
 * reporting; this module owns the filesystem contract.
 */
export async function signOutStep(input: StepLogoutOptions): Promise<StepLogoutOutcome> {
	if (input.stopSessions) {
		try {
			await input.stopSessions();
		} catch (error) {
			// Signing out must still remove the credential. The Host's shutdown
			// path already logs teardown failures; this is the same boundary.
			console.error("Could not stop sessions before signing out of Step:", error);
		}
	}
	const env = input.env ?? process.env;
	const report = await logoutStepCredentials({
		nativePath: input.authPath,
		legacyPath: input.legacyPath ?? getLegacyStepAuthPath(env),
		env,
	});
	// The provider's endpoint hints follow the stored profile; without one the
	// next session must not keep sending to the previous region.
	syncStepLoginProfileEndpoint(input.authPath, env);
	return {
		removed: report.removedNative || report.removedLegacy,
		accountSessionRemoved: report.removedLoginState,
		remainingSource: report.remainingSource,
	};
}
