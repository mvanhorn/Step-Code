import { existsSync, readFileSync } from "node:fs";
import {
	loginStepInBrowser,
	loginStepWithApiKey,
	resolveStepLoginProfiles,
	type StepLoginProfileId,
	type StepLoginStatus,
} from "@step-harness/coding-agent";

/**
 * What the browser is allowed to know about the model credential.
 *
 * Signing in writes `auth.json`, either from a terminal (`step login`) or from
 * the sign-in dialog (`WebLoginController` below); both write the same
 * file and the host reuses it. The UI has to explain where its credential comes
 * from, so this reports the source and the shape — never the secret itself.
 * There is no field here that can carry a token.
 */
export interface LoginReport {
	/** Environment variable that supplies the credential, when one does. */
	readonly source: "environment" | "auth.json" | "none";
	/** Provider id the credential belongs to, e.g. `step`. */
	readonly provider?: string;
	/** Login profile recorded at sign-in, e.g. `step_plan`. */
	readonly profile?: string;
	/** Stored OAuth UID, only when it matches the kernel's checked account. */
	readonly userId?: string;
	/** Where the credential lives, for a "run this in a terminal" hint. */
	readonly path?: string;
	/** True when a credential exists, whatever the provider says about it. */
	readonly configured: boolean;
	/**
	 * What the provider said when the credential was checked: `valid`, `invalid`
	 * (rejected), or `unavailable` (could not be reached, so unknown). Absent
	 * when no check was possible.
	 */
	readonly validity?: StepLoginStatus["validity"];
	/**
	 * The Step account session in `step-login.json`, beside the credential.
	 *
	 * Independent of `configured`: an API-key sign-in has no account session and
	 * is still configured; a Step Plan key with an expired session still runs
	 * models and only loses the account identity.
	 */
	readonly session: NonNullable<StepLoginStatus["session"]>;
	/** Terminal alternative to the page's sign-in controls. */
	readonly loginCommand: string;
	/**
	 * The Step Plan page of the platform this credential belongs to, where
	 * "Upgrade" leads: `platform.stepfun.ai` for an overseas plan or key, the
	 * mainland platform otherwise (also when the region is unknown).
	 */
	readonly planUrl: string;
}

export interface LoginReportInput {
	/** Result of the product's own credential inspection. */
	readonly status: StepLoginStatus;
	/** Credential file path, reported as-is (it is a path, not a secret). */
	readonly authPath: string;
	readonly env?: NodeJS.ProcessEnv;
	/** Overridable so tests do not touch the real filesystem. */
	readonly read?: (path: string) => string;
	readonly exists?: (path: string) => boolean;
}

/** The environment key the loopback host resolves a Step credential from first. */
const ENVIRONMENT_KEY = "STEP_API_KEY";

/**
 * Whether a usable credential is stored, independent of the network.
 *
 * `getStepLoginStatus` may report `validity: "unavailable"` when the provider
 * cannot be reached, which is the wrong question here: the credential is still on
 * disk and the next request may well succeed. Presence is read from the file
 * shape, never from the token.
 */
function storedCredential(
	authPath: string,
	read: (path: string) => string,
): { profile?: string; userId?: string } | undefined {
	try {
		const parsed: unknown = JSON.parse(read(authPath));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("step" in parsed)) return undefined;
		const entry = parsed.step;
		if (!entry || typeof entry !== "object" || Array.isArray(entry) || !("type" in entry)) return undefined;
		if (!entry || (entry.type !== "oauth" && entry.type !== "api_key")) return undefined;
		const secret =
			entry.type === "oauth"
				? "access" in entry
					? entry.access
					: undefined
				: "key" in entry
					? entry.key
					: undefined;
		if (typeof secret !== "string" || !secret.trim()) return undefined;
		const profile =
			"profile" in entry && typeof entry.profile === "string" && entry.profile.trim()
				? entry.profile.trim()
				: undefined;
		const userId =
			entry.type === "oauth" &&
			"uid" in entry &&
			typeof entry.uid === "string" &&
			entry.uid.trim() &&
			entry.uid.trim().length <= 256
				? entry.uid.trim()
				: undefined;
		return { ...(profile ? { profile } : {}), ...(userId ? { userId } : {}) };
	} catch {
		// Missing or malformed: treated as no credential, which the UI reports as
		// "sign in from a terminal" — the same remedy either way.
		return undefined;
	}
}

/**
 * The Step Plan page for a stored profile, as `step login` links it
 * (`${authBaseUrl}/step-plan`). An environment key or a key stored without a
 * profile has no recorded region; the mainland platform is the default there,
 * as it is for the provider itself.
 */
function stepPlanUrl(profile: string | undefined, env: Record<string, string | undefined>): string {
	const profiles = resolveStepLoginProfiles(env);
	const match = profiles.find((candidate) => candidate.id === profile) ?? profiles.find((p) => p.id === "step_plan");
	return `${match?.authBaseUrl ?? "https://platform.stepfun.com"}/step-plan`;
}

/**
 * Project the kernel's login status into the browser-safe report.
 *
 * Presence comes from the filesystem or the environment; reachability comes
 * from the kernel's check. Keeping them apart matters because they need
 * different advice: an unreachable provider is not something a user fixes by
 * signing in again, and an expired token is.
 */
export function buildLoginReport(input: LoginReportInput): LoginReport {
	const env = input.env ?? process.env;
	const read = input.read ?? ((path: string) => readFileSync(path, "utf8"));
	const exists = input.exists ?? existsSync;
	const viaEnvironment = (env[ENVIRONMENT_KEY] ?? "").trim() !== "";
	const stored = viaEnvironment ? undefined : storedCredential(input.authPath, read);
	const configured = viaEnvironment || stored !== undefined || input.status.credentialConfigured === true;
	const profile = stored?.profile ?? input.status.profile;
	return {
		source: !configured ? "none" : viaEnvironment ? "environment" : "auth.json",
		...(configured ? { provider: "step" } : {}),
		...(configured && profile ? { profile } : {}),
		...(stored?.userId &&
		input.status.credentialConfigured &&
		input.status.validity === "valid" &&
		input.status.account === stored.userId
			? { userId: stored.userId }
			: {}),
		// The path is worth naming only when it is the thing to go and look at.
		...(configured && !viaEnvironment && exists(input.authPath) ? { path: input.authPath } : {}),
		configured,
		// A check ran only when the kernel reached a verdict; an unreachable
		// provider reports "unavailable", not a failure of the credential.
		...(configured ? { validity: input.status.validity } : {}),
		session: input.status.session ?? { state: "missing" },
		loginCommand: "step login",
		planUrl: stepPlanUrl(configured ? profile : undefined, env),
	};
}

/** A sign-in method the desktop dialog offers: one of the four `step login` profiles. */
export interface LoginMethod {
	readonly id: StepLoginProfileId;
	/** `browser`: Step Plan sign-in in the system browser; `apiKey`: paste a platform key. */
	readonly credentialSource: "browser" | "apiKey";
	/** `cn` for the mainland platform, `global` for the international one. */
	readonly region: "cn" | "global";
	/** Where the user creates a platform API key for this region. */
	readonly keyPageUrl: string;
}

export function loginMethods(env: Record<string, string | undefined> = process.env): LoginMethod[] {
	return resolveStepLoginProfiles(env).map((profile) => ({
		id: profile.id,
		credentialSource: profile.credentialSource,
		region: profile.id.endsWith("_oversea") ? "global" : "cn",
		keyPageUrl: profile.keyPageUrl,
	}));
}

/** State of the browser sign-in, as `GET /api/v1/login/browser` reports it. */
export interface BrowserLoginState {
	readonly state: "idle" | "pending" | "completed" | "failed";
	readonly profile?: StepLoginProfileId;
	/** The authorize URL to open; present while pending. */
	readonly authUrl?: string;
	/** Non-fatal account-session problem; the credential is already saved. */
	readonly warning?: string;
	readonly error?: string;
}

export type ApiKeyLoginResult =
	| { readonly ok: true; readonly warning?: string }
	| { readonly ok: false; readonly code: "invalid_key" | "unavailable"; readonly error: string };

export interface WebLoginControllerOptions {
	readonly authPath: () => string;
	/** Called after a credential was written, so cached reports are dropped. */
	readonly onSaved: () => void;
	readonly env?: Record<string, string | undefined>;
	/** Overridable so tests do not reach the network. */
	readonly loginWithApiKey?: typeof loginStepWithApiKey;
	readonly loginInBrowser?: typeof loginStepInBrowser;
}

/**
 * The page sign-in, run by the host because only it can write `auth.json`.
 *
 * The kernel does the work (`loginStepWithApiKey`, `loginStepInBrowser`) and
 * writes the credential exactly as `step login` would; this class only keeps
 * the one browser sign-in that may be in flight, so the page can poll it and
 * cancel it when the user goes back.
 */
export class WebLoginController {
	private readonly options: WebLoginControllerOptions;
	private browser: { controller: AbortController; state: BrowserLoginState } | undefined;
	/** Every kernel sign-in still running, so a sign-out can wait for its write to land first. */
	private readonly inFlight = new Set<{ controller: AbortController; done: Promise<unknown> }>();

	constructor(options: WebLoginControllerOptions) {
		this.options = options;
	}

	private method(id: unknown, source: LoginMethod["credentialSource"]): LoginMethod | undefined {
		return loginMethods(this.options.env).find((method) => method.id === id && method.credentialSource === source);
	}

	isApiKeyMethod(id: unknown): id is StepLoginProfileId {
		return this.method(id, "apiKey") !== undefined;
	}

	isBrowserMethod(id: unknown): id is StepLoginProfileId {
		return this.method(id, "browser") !== undefined;
	}

	/** Validate the key against its region and save it only when the provider accepts it. */
	async withApiKey(profile: StepLoginProfileId, apiKey: string): Promise<ApiKeyLoginResult> {
		const login = this.options.loginWithApiKey ?? loginStepWithApiKey;
		const controller = new AbortController();
		const cancelled: ApiKeyLoginResult = { ok: false, code: "unavailable", error: "The sign-in was cancelled" };
		const run = login({
			authPath: this.options.authPath(),
			profile,
			apiKey,
			signal: controller.signal,
			...(this.options.env ? { env: this.options.env } : {}),
		});
		let result: Awaited<typeof run>;
		try {
			result = await this.track(controller, run);
		} catch (caught) {
			if (controller.signal.aborted) return cancelled;
			throw caught;
		}
		// A sign-out that started meanwhile removes whatever this call wrote,
		// so success must not be reported or cached.
		if (controller.signal.aborted) return cancelled;
		if (result.validity === "valid") {
			this.cancelBrowser();
			this.options.onSaved();
			return { ok: true, ...(result.warning ? { warning: result.warning } : {}) };
		}
		return result.validity === "invalid"
			? { ok: false, code: "invalid_key", error: "The API key was rejected" }
			: { ok: false, code: "unavailable", error: result.error ?? "The provider could not be reached" };
	}

	/**
	 * Start the Step Plan browser sign-in and resolve with the authorize URL.
	 * The approval is awaited in the background; poll `browserState()`.
	 */
	startBrowser(profile: StepLoginProfileId): Promise<BrowserLoginState> {
		this.cancelBrowser();
		const controller = new AbortController();
		const entry: { controller: AbortController; state: BrowserLoginState } = {
			controller,
			state: { state: "pending", profile },
		};
		this.browser = entry;
		const login = this.options.loginInBrowser ?? loginStepInBrowser;
		return new Promise((resolve) => {
			this.track(
				controller,
				login({
					authPath: this.options.authPath(),
					profile,
					signal: controller.signal,
					...(this.options.env ? { env: this.options.env } : {}),
					onAuthUrl: (authUrl) => {
						entry.state = { state: "pending", profile, authUrl };
						resolve(entry.state);
					},
				}),
			).then(
				(session) => {
					if (controller.signal.aborted) return;
					entry.state = {
						state: "completed",
						profile,
						...(session?.warning ? { warning: session.warning } : {}),
					};
					this.options.onSaved();
					resolve(entry.state);
				},
				(caught: unknown) => {
					// A cancelled sign-in is the user going back, not a failure to show.
					if (controller.signal.aborted) return resolve({ state: "idle" });
					entry.state = {
						state: "failed",
						profile,
						error: caught instanceof Error ? caught.message : String(caught),
					};
					resolve(entry.state);
				},
			);
		});
	}

	browserState(): BrowserLoginState {
		return this.browser?.state ?? { state: "idle" };
	}

	/** Stop waiting for the browser approval; a later approval is then ignored. */
	cancelBrowser(): void {
		if (!this.browser) return;
		this.browser.controller.abort();
		this.browser = undefined;
	}

	/**
	 * Cancel every sign-in and wait until each has settled.
	 *
	 * Aborting alone is not enough before a sign-out: a sign-in past its last
	 * abort check may still be writing `auth.json` or `step-login.json`, and a
	 * write landing after the sign-out removed them would restore a credential.
	 * Once this resolves, no sign-in started before the call writes again.
	 */
	async cancelAll(): Promise<void> {
		this.cancelBrowser();
		const running = [...this.inFlight];
		for (const entry of running) entry.controller.abort();
		await Promise.allSettled(running.map((entry) => entry.done));
	}

	private track<T>(controller: AbortController, run: Promise<T>): Promise<T> {
		const entry = { controller, done: run };
		this.inFlight.add(entry);
		const forget = () => this.inFlight.delete(entry);
		run.then(forget, forget);
		return run;
	}
}
