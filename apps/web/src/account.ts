import type { StepAccountProfileOutcome } from "@step-harness/coding-agent";

/**
 * The signed-in account as the sidebar shows it: a display name and an avatar.
 *
 * Read from the account session `step login` (or the sign-in dialog) stored
 * beside `auth.json`. Only display fields cross to the browser; the session
 * tokens and the account id stay in the host.
 */
export interface AccountReport {
	/**
	 * `ready`: `account` is set. `missing`: no account session (API-key sign-in).
	 * `expired`: the session was rejected; signing in again restores it.
	 * `unavailable`: the developer center could not be reached; ask again later.
	 */
	readonly status: StepAccountProfileOutcome["status"];
	readonly account?: { readonly name: string; readonly avatarUrl?: string };
}

/** A profile changes rarely; a live session is re-asked after this long. */
const READY_TTL_MS = 10 * 60_000;
/** Absent or failed answers are retried sooner, so a fresh sign-in shows up quickly. */
const RETRY_TTL_MS = 30_000;

/**
 * Cached, de-duplicated account lookups.
 *
 * The page asks on every load and after every sign-in; each answer costs a
 * request to the developer center, so one in-flight lookup is shared and the
 * result is kept for a while. `invalidate()` runs when a sign-in saves a new
 * credential, so the next ask sees the new account.
 */
export class AccountProfileCache {
	private readonly load: () => Promise<StepAccountProfileOutcome>;
	private readonly now: () => number;
	private cached: { at: number; ttl: number; value: AccountReport } | undefined;
	private pending: Promise<AccountReport> | undefined;
	private generation = 0;

	constructor(load: () => Promise<StepAccountProfileOutcome>, now: () => number = Date.now) {
		this.load = load;
		this.now = now;
	}

	async get(): Promise<AccountReport> {
		const cached = this.cached;
		if (cached && this.now() - cached.at < cached.ttl) return cached.value;
		if (this.pending) return this.pending;
		const generation = this.generation;
		const pending = this.lookup().then((value) => {
			// A sign-in that landed while this lookup ran replaced the account;
			// caching the old answer would show the previous user.
			if (generation === this.generation) {
				this.cached = { at: this.now(), ttl: value.status === "ready" ? READY_TTL_MS : RETRY_TTL_MS, value };
			}
			return value;
		});
		this.pending = pending;
		try {
			return await pending;
		} finally {
			if (this.pending === pending) this.pending = undefined;
		}
	}

	invalidate(): void {
		this.generation += 1;
		this.cached = undefined;
		this.pending = undefined;
	}

	private async lookup(): Promise<AccountReport> {
		try {
			return toAccountReport(await this.load());
		} catch {
			// The lookup is decoration: any failure means "unknown for now", and
			// the sidebar keeps its credential-based label.
			return { status: "unavailable" };
		}
	}
}

/** Project the product outcome into the browser-safe report. */
export function toAccountReport(outcome: StepAccountProfileOutcome): AccountReport {
	if (outcome.status !== "ready") return { status: outcome.status };
	const { name, avatarUrl } = outcome.account;
	return { status: "ready", account: { name, ...(avatarUrl ? { avatarUrl } : {}) } };
}
