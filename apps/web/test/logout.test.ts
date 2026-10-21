import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveStepLoginState } from "@step-harness/coding-agent";
import { signOutStep } from "../src/logout.ts";

async function fixture(): Promise<{ dir: string; authPath: string; legacyPath: string }> {
	const dir = await mkdtemp(join(tmpdir(), "stepcode-web-logout-"));
	const authPath = join(dir, "auth.json");
	const legacyPath = join(dir, "legacy-auth.json");
	await writeFile(
		authPath,
		`${JSON.stringify({
			step: {
				type: "oauth",
				access: "fixture-key",
				refresh: "step-static-credential",
				expires: Number.MAX_SAFE_INTEGER,
				profile: "step_plan",
			},
		})}\n`,
		"utf8",
	);
	return { dir, authPath, legacyPath };
}

async function writeSession(authPath: string): Promise<void> {
	const now = Math.floor(Date.now() / 1000);
	await saveStepLoginState(
		{
			version: 1,
			profile: "step_plan",
			appId: "10300",
			deviceId: "device-1",
			accessToken: "access",
			refreshToken: "refresh",
			accessExpiresAt: now + 1800,
			refreshExpiresAt: now + 30 * 24 * 60 * 60,
		},
		{ STEPCODE_AUTH_PATH: authPath },
	);
}

test("sign-out removes the Step credential and the account session like step logout", async () => {
	const { dir, authPath, legacyPath } = await fixture();
	const order: string[] = [];
	try {
		await writeSession(authPath);
		assert.equal(existsSync(join(dir, "step-login.json")), true);
		const outcome = await signOutStep({
			authPath,
			legacyPath,
			env: {},
			stopSessions: async () => {
				order.push("stop");
			},
		});
		assert.deepEqual(order, ["stop"]);
		assert.deepEqual(outcome, { removed: true, accountSessionRemoved: true, remainingSource: null });
		// AuthStorage keeps a shared auth.json for other providers; only the Step
		// entry must be gone.
		const stored = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>;
		assert.equal("step" in stored, false);
		assert.equal(existsSync(join(dir, "step-login.json")), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("an environment key survives sign-out and is reported", async () => {
	const { dir, authPath, legacyPath } = await fixture();
	try {
		const outcome = await signOutStep({
			authPath,
			legacyPath,
			env: { STEP_API_KEY: "environment-key" },
		});
		assert.equal(outcome.remainingSource, "environment");
		assert.equal(outcome.removed, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a failing session stop does not keep the credential on disk", async () => {
	const { dir, authPath, legacyPath } = await fixture();
	const originalError = console.error;
	console.error = () => {};
	try {
		const outcome = await signOutStep({
			authPath,
			legacyPath,
			env: {},
			stopSessions: async () => {
				throw new Error("teardown failed");
			},
		});
		assert.equal(outcome.removed, true);
		const stored = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>;
		assert.equal("step" in stored, false);
	} finally {
		console.error = originalError;
		await rm(dir, { recursive: true, force: true });
	}
});
