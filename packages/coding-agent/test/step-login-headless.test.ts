import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	loginStepInBrowser,
	loginStepWithApiKey,
	readStepLoginCredential,
	readStepLoginProfile,
} from "../src/step/login-flow.ts";
import { readStepLoginState, saveStepLoginState } from "../src/step/login-state.ts";

const dirs: string[] = [];
afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function authFile(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "step-login-headless-"));
	dirs.push(dir);
	return join(dir, "auth.json");
}

describe("headless Step login (desktop)", () => {
	it("saves an API key only after the profile endpoint accepts it", async () => {
		const authPath = await authFile();
		const requests: Array<{ url: string; authorization: string | null }> = [];
		const result = await loginStepWithApiKey({
			authPath,
			env: {},
			profile: "platform_oversea",
			apiKey: "  sk-oversea  ",
			fetch: async (url, init) => {
				requests.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
				return new Response("{}", { status: 200 });
			},
		});
		expect(result).toEqual({ validity: "valid" });
		expect(requests).toEqual([{ url: "https://api.stepfun.ai/v1/models", authorization: "Bearer sk-oversea" }]);
		expect(readStepLoginCredential(authPath)).toMatchObject({ type: "oauth", access: "sk-oversea" });
		expect(readStepLoginProfile(authPath)).toBe("platform_oversea");
	});

	it("does not write a rejected or unverifiable key", async () => {
		const authPath = await authFile();
		const rejected = await loginStepWithApiKey({
			authPath,
			env: {},
			profile: "platform_cn",
			apiKey: "sk-bad",
			fetch: async () => new Response(null, { status: 401 }),
		});
		expect(rejected).toEqual({ validity: "invalid" });
		const offline = await loginStepWithApiKey({
			authPath,
			env: {},
			profile: "platform_cn",
			apiKey: "sk-maybe",
			fetch: async () => {
				throw new Error("offline");
			},
		});
		expect(offline).toMatchObject({ validity: "unavailable" });
		expect(existsSync(authPath)).toBe(false);
	});

	it("refuses a browser profile for an API key and an empty key", async () => {
		const authPath = await authFile();
		await expect(loginStepWithApiKey({ authPath, env: {}, profile: "step_plan", apiKey: "sk" })).rejects.toThrow(
			/Unknown Step login profile/,
		);
		await expect(loginStepWithApiKey({ authPath, env: {}, profile: "platform_cn", apiKey: "  " })).rejects.toThrow(
			/cannot be empty/,
		);
	});

	it("runs the Step Plan browser sign-in against the chosen region and saves the credential", async () => {
		const authPath = await authFile();
		const flowId = "b".repeat(32);
		const urls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				urls.push(url);
				if (url.endsWith("/init"))
					return new Response(
						JSON.stringify({
							status: 0,
							flow_id: flowId,
							poll_interval_sec: 1,
							expires_at: Date.now() / 1000 + 600,
						}),
					);
				return new Response(
					JSON.stringify({ status: 0, state: "ready", uid: "u-9", credential: { api_key: "plan-key" } }),
				);
			}),
		);
		let authUrl = "";
		await loginStepInBrowser({
			authPath,
			env: {},
			profile: "step_plan_oversea",
			signal: new AbortController().signal,
			onAuthUrl: (url) => {
				authUrl = url;
			},
		});
		expect(urls[0]).toMatch(/^https:\/\/platform\.stepfun\.ai\//);
		expect(authUrl).toContain(flowId);
		expect(readStepLoginCredential(authPath)).toMatchObject({ type: "oauth", access: "plan-key", uid: "u-9" });
		expect(readStepLoginProfile(authPath)).toBe("step_plan_oversea");
	});

	it("stores the account session beside auth.json and an API key sign-in drops it", async () => {
		const authPath = await authFile();
		const sessionEnv = { STEPCODE_AUTH_PATH: authPath };
		// A previous account's session must be replaced, not kept.
		await saveStepLoginState(
			{
				version: 1,
				profile: "step_plan",
				appId: "10300",
				deviceId: "old-device",
				accessToken: "old-access",
				refreshToken: "old-refresh",
				accessExpiresAt: Math.floor(Date.now() / 1000) + 1800,
			},
			sessionEnv,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url.endsWith("/init"))
					return new Response(
						JSON.stringify({
							status: 0,
							flow_id: "c".repeat(32),
							poll_interval_sec: 1,
							expires_at: Date.now() / 1000 + 600,
						}),
					);
				return new Response(
					JSON.stringify({
						status: 0,
						state: "ready",
						credential: {
							api_key: "plan-key",
							login: {
								access_token: "new-access",
								refresh_token: "new-refresh",
								device_id: "device-2",
								app_id: "10300",
								expires_in: 1800,
							},
						},
					}),
				);
			}),
		);
		await loginStepInBrowser({
			authPath,
			env: {},
			profile: "step_plan",
			signal: new AbortController().signal,
			onAuthUrl: () => {},
		});
		expect(readStepLoginState(sessionEnv)).toMatchObject({
			profile: "step_plan",
			accessToken: "new-access",
			refreshToken: "new-refresh",
			deviceId: "device-2",
		});

		await loginStepWithApiKey({
			authPath,
			env: {},
			profile: "platform_cn",
			apiKey: "sk-cn",
			fetch: async () => new Response("{}", { status: 200 }),
		});
		expect(readStepLoginState(sessionEnv)).toBeUndefined();
	});
});
