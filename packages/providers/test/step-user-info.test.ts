import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchStepUserInfo, StepUserInfoError } from "../src/step-provider/index.ts";

const AUTH_BASE_URL = "https://auth.example.test";

const input = {
	authBaseUrl: AUTH_BASE_URL,
	accessToken: "access-jwt",
	refreshToken: "refresh-jwt",
	appId: "10300",
	deviceId: "device-1",
};

function ok(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("fetchStepUserInfo", () => {
	it("authenticates with both tokens and reads the display fields", async () => {
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			expect(String(url)).toBe(`${AUTH_BASE_URL}/api/step.openapi.devcenter.Dashboard/UserInfo`);
			const headers = new Headers(init?.headers);
			expect(headers.get("Oasis-Token")).toBe("access-jwt...refresh-jwt");
			expect(headers.get("cookie")).toBe("Oasis-Token=access-jwt...refresh-jwt");
			expect(headers.get("Oasis-appID")).toBe("10300");
			expect(headers.get("Oasis-Webid")).toBe("device-1");
			expect(headers.get("connect-protocol-version")).toBe("1");
			expect(init?.method).toBe("POST");
			expect(init?.body).toBe("{}");
			return ok({
				status: "OK",
				uid: "12345",
				mobile: "138****0000",
				nickname: " Ada ",
				avatarUrl: "https://cdn.example.test/a.png",
				companyInfo: { companyName: "ignored" },
			});
		});

		await expect(fetchStepUserInfo({ ...input, fetch: fetchImpl })).resolves.toEqual({
			uid: "12345",
			nickname: "Ada",
			avatarUrl: "https://cdn.example.test/a.png",
			mobile: "138****0000",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("accepts the proto field name and drops a non-http avatar", async () => {
		const snake = vi.fn(async () => ok({ nickname: "Ada", avatar_url: "https://cdn.example.test/b.png" }));
		await expect(fetchStepUserInfo({ ...input, fetch: snake })).resolves.toMatchObject({
			avatarUrl: "https://cdn.example.test/b.png",
		});
		const script = vi.fn(async () => ok({ nickname: "Ada", avatarUrl: "javascript:alert(1)" }));
		const info = await fetchStepUserInfo({ ...input, fetch: script });
		expect(info.avatarUrl).toBeUndefined();
	});

	it("reports a 401 as unauthenticated and other failures as transient", async () => {
		const rejected = vi.fn(async () => new Response('{"code":"unauthenticated"}', { status: 401 }));
		await expect(fetchStepUserInfo({ ...input, fetch: rejected })).rejects.toMatchObject({
			name: "StepUserInfoError",
			failure: "unauthenticated",
			httpStatus: 401,
		});
		const down = vi.fn(async () => new Response("", { status: 503 }));
		await expect(fetchStepUserInfo({ ...input, fetch: down })).rejects.toMatchObject({ failure: "transient" });
		const offline = vi.fn(async () => {
			throw new TypeError("fetch failed");
		});
		const error = await fetchStepUserInfo({ ...input, fetch: offline }).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(StepUserInfoError);
		expect((error as StepUserInfoError).failure).toBe("transient");
	});
});
