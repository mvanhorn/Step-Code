import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStepAccountProfile } from "../src/step/account-profile.ts";
import { readStepLoginState, type StepLoginState, saveStepLoginState } from "../src/step/login-state.ts";

function stored(overrides: Partial<StepLoginState> = {}): StepLoginState {
	return {
		version: 1,
		profile: "step_plan",
		appId: "10300",
		deviceId: "device-1",
		accessToken: "access-jwt",
		refreshToken: "refresh-jwt",
		accessExpiresAt: Math.floor(Date.now() / 1000) + 1800,
		...overrides,
	};
}

function ok(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

let dir: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "step-account-profile-"));
	env = { STEPCODE_LOGIN_STATE_PATH: join(dir, "step-login.json") };
});

afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
});

describe("getStepAccountProfile", () => {
	it("reports missing without a stored session and makes no request", async () => {
		const fetchSpy = vi.fn();
		expect(await getStepAccountProfile({ env, fetch: fetchSpy })).toEqual({ status: "missing" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("asks the session's developer center and returns the nickname and avatar", async () => {
		await saveStepLoginState(stored({ profile: "step_plan_oversea" }), env);
		const fetchSpy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			expect(String(url)).toBe("https://platform.stepfun.ai/api/step.openapi.devcenter.Dashboard/UserInfo");
			expect(new Headers(init?.headers).get("Oasis-Token")).toBe("access-jwt...refresh-jwt");
			return ok({ uid: "7", nickname: "Ada", avatarUrl: "https://cdn.example.test/a.png" });
		});
		expect(await getStepAccountProfile({ env, fetch: fetchSpy })).toEqual({
			status: "ready",
			account: { name: "Ada", avatarUrl: "https://cdn.example.test/a.png", uid: "7", profile: "step_plan_oversea" },
		});
	});

	it("falls back to the email when no nickname is set", async () => {
		await saveStepLoginState(stored(), env);
		const outcome = await getStepAccountProfile({ env, fetch: vi.fn(async () => ok({ email: "ada@example.test" })) });
		expect(outcome).toMatchObject({ status: "ready", account: { name: "ada@example.test" } });
	});

	it("reports a rejected session as expired without deleting it", async () => {
		await saveStepLoginState(stored(), env);
		const outcome = await getStepAccountProfile({
			env,
			fetch: vi.fn(async () => new Response("{}", { status: 401 })),
		});
		expect(outcome.status).toBe("expired");
		expect(readStepLoginState(env)).toBeDefined();
	});

	it("reports a transient failure as unavailable", async () => {
		await saveStepLoginState(stored(), env);
		const outcome = await getStepAccountProfile({ env, fetch: vi.fn(async () => new Response("", { status: 502 })) });
		expect(outcome).toMatchObject({ status: "unavailable", reason: expect.stringContaining("502") });
	});
});
