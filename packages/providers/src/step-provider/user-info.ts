/**
 * Read the signed-in account's public profile from the developer center.
 *
 * `step.openapi.devcenter.Dashboard/UserInfo` is a Connect-RPC unary call the
 * developer center's own pages make. It authenticates with the same
 * `Oasis-Token` value the refresh uses — the access and refresh JWTs joined by
 * `...` — so a host that holds the stored account session can call it without
 * a cookie jar.
 *
 * Only the display fields are returned. The response also carries the phone
 * number, company and billing details, which no caller needs.
 */

import { parseAuthBaseUrl } from "./login-client.ts";

/** Connect-RPC procedure that answers the account's profile. */
const USER_INFO_PATH = "/api/step.openapi.devcenter.Dashboard/UserInfo";

/** A profile is decoration; a stuck request must not hold a page. */
const USER_INFO_TIMEOUT_MS = 10_000;

export interface StepUserInfo {
	/** Account id, as the server's decimal string (int64 in the proto). */
	readonly uid?: string;
	/** Display name the user set on the platform. */
	readonly nickname?: string;
	/** Avatar image URL. */
	readonly avatarUrl?: string;
	readonly email?: string;
	/** Phone number as the server shows it (typically masked). */
	readonly mobile?: string;
}

export type StepUserInfoFailure =
	/** The server rejected the session; only a new sign-in recovers. */
	| "unauthenticated"
	/** Transport or server-side problem; retrying later may work. */
	| "transient";

export class StepUserInfoError extends Error {
	readonly failure: StepUserInfoFailure;
	readonly httpStatus?: number;

	constructor(failure: StepUserInfoFailure, message: string, options: { httpStatus?: number; cause?: unknown } = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "StepUserInfoError";
		this.failure = failure;
		if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
	}
}

export interface FetchStepUserInfoInput {
	/** Developer center origin that issued the session, e.g. `https://platform.stepfun.com`. */
	readonly authBaseUrl: string;
	readonly accessToken: string;
	readonly refreshToken: string;
	readonly appId: string;
	readonly deviceId: string;
	readonly signal?: AbortSignal;
	readonly fetch?: typeof fetch;
}

/** Fetch the account profile for a stored account session. */
export async function fetchStepUserInfo(input: FetchStepUserInfoInput): Promise<StepUserInfo> {
	const base = parseAuthBaseUrl(input.authBaseUrl);
	const controller = new AbortController();
	if (input.signal?.aborted) controller.abort(input.signal.reason);
	const timer = setTimeout(() => controller.abort(), USER_INFO_TIMEOUT_MS);
	const onAbort = () => controller.abort();
	input.signal?.addEventListener("abort", onAbort, { once: true });
	const token = `${input.accessToken}...${input.refreshToken}`;
	try {
		let response: Response;
		try {
			response = await (input.fetch ?? globalThis.fetch.bind(globalThis))(`${base.origin}${USER_INFO_PATH}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"connect-protocol-version": "1",
					// The gateway reads the token from either the header or the cookie;
					// both are sent, as the developer center's own pages do.
					"Oasis-Token": token,
					cookie: `Oasis-Token=${token}`,
					"Oasis-appID": input.appId,
					"Oasis-Platform": "web",
					"Oasis-Webid": input.deviceId,
				},
				body: "{}",
				signal: controller.signal,
			});
		} catch (cause) {
			throw new StepUserInfoError("transient", "Step account profile request failed", { cause });
		}
		if (!response.ok) {
			const failure = response.status === 401 ? "unauthenticated" : "transient";
			throw new StepUserInfoError(failure, `Step account profile request failed (HTTP ${response.status})`, {
				httpStatus: response.status,
			});
		}
		const payload: unknown = await response.json().catch((cause: unknown) => {
			throw new StepUserInfoError("transient", "Step account profile returned an unreadable body", { cause });
		});
		return parseUserInfo(payload);
	} finally {
		clearTimeout(timer);
		input.signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * Narrow the Connect JSON body.
 *
 * Connect encodes proto fields in lowerCamelCase (`avatarUrl`) but accepts the
 * original names too, so both spellings are read.
 */
function parseUserInfo(payload: unknown): StepUserInfo {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new StepUserInfoError("transient", "Step account profile returned an unexpected response");
	}
	const record = payload as Record<string, unknown>;
	const uid = record.uid;
	const nickname = readText(record.nickname);
	const avatarUrl = readHttpUrl(record.avatarUrl ?? record.avatar_url);
	const email = readText(record.email);
	const mobile = readText(record.mobile);
	return {
		...(typeof uid === "string" && /^\d+$/.test(uid) && uid !== "0" ? { uid } : {}),
		...(typeof uid === "number" && Number.isSafeInteger(uid) && uid > 0 ? { uid: String(uid) } : {}),
		...(nickname ? { nickname } : {}),
		...(avatarUrl ? { avatarUrl } : {}),
		...(email ? { email } : {}),
		...(mobile ? { mobile } : {}),
	};
}

function readText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Only an absolute http(s) URL may reach an `<img src>`. */
function readHttpUrl(value: unknown): string | undefined {
	const text = readText(value);
	if (!text) return undefined;
	try {
		const url = new URL(text);
		return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}
