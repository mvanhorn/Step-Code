/**
 * `hasUsableCustomModel`: whether a bring-your-own-key model runs without a
 * Step credential, which decides whether the page needs the sign-in gate.
 *
 * Runs under a scratch HOME, so the developer's own `~/.stepcode` is never read.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hasUsableCustomModel } from "../src/model-providers.ts";
import { logoutStepCredentials } from "@step-harness/coding-agent";

const ENV_KEYS = [
	"HOME",
	"STEP_CODING_AGENT_DIR",
	"STEPCODE_STORAGE_ROOT_DIR",
	"STEPCODE_CONFIG_DIR",
	"STEPCODE_AUTH_PATH",
	"STEP_API_KEY",
] as const;
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
let home = "";

test.before(async () => {
	home = await realpath(await mkdtemp(join(tmpdir(), "stepcode-web-custom-models-")));
	for (const key of ENV_KEYS) delete process.env[key];
	process.env.HOME = home;
	await mkdir(join(home, ".stepcode"), { recursive: true });
});

test.after(async () => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(home, { recursive: true, force: true });
});

async function writeConfig(files: { models?: unknown; auth?: unknown }): Promise<void> {
	const root = join(home, ".stepcode");
	await writeFile(join(root, "models.json"), JSON.stringify(files.models ?? { providers: {} }));
	await writeFile(join(root, "auth.json"), JSON.stringify(files.auth ?? {}));
}

const gateway = {
	baseUrl: "http://127.0.0.1:9/v1",
	api: "openai-completions",
	models: [{ id: "byok-model" }],
};

test("no custom provider means no custom model, whatever Step holds", async () => {
	await writeConfig({
		auth: { step: { type: "api_key", key: "fixture-only", profile: "platform_cn" } },
	});
	assert.equal(await hasUsableCustomModel(), false);
});

test("a custom provider with a key is usable without a Step credential", async () => {
	await writeConfig({ models: { providers: { gateway: { ...gateway, apiKey: "fixture-only" } } } });
	assert.equal(await hasUsableCustomModel(), true);
	// A key stored in auth.json counts the same as one in the declaration.
	await writeConfig({
		models: { providers: { gateway } },
		auth: { gateway: { type: "api_key", key: "fixture-only" } },
	});
	assert.equal(await hasUsableCustomModel(), true);
});

test("a custom provider without a key or models is not usable", async () => {
	await writeConfig({ models: { providers: { gateway } } });
	assert.equal(await hasUsableCustomModel(), false);
	await writeConfig({ models: { providers: { gateway: { ...gateway, apiKey: "fixture-only", models: [] } } } });
	assert.equal(await hasUsableCustomModel(), false);
});

test("a Step sign-out keeps the custom provider running", async () => {
	// A Step account and a BYOK provider coexist; signing out removes only
	// StepFun's credential and account session, never the user's own provider.
	await writeConfig({
		models: { providers: { gateway: { ...gateway, apiKey: "fixture-only" } } },
		auth: {
			step: { type: "api_key", key: "fixture-only", profile: "platform_cn" },
			gateway: { type: "api_key", key: "fixture-only" },
		},
	});
	assert.equal(await hasUsableCustomModel(), true);

	await logoutStepCredentials({ nativePath: join(home, ".stepcode", "auth.json"), env: {} });

	// StepFun's entry is gone; the custom provider still runs without the gate.
	assert.equal(await hasUsableCustomModel(), true);
	const auth = JSON.parse(await readFile(join(home, ".stepcode", "auth.json"), "utf8")) as Record<string, unknown>;
	assert.equal("step" in auth, false, "the StepFun credential must be removed");
	assert.equal("gateway" in auth, true, "the user's own provider key must survive");
});

test("an unreadable models.json answers false instead of throwing", async () => {
	await writeFile(join(home, ".stepcode", "models.json"), "{ not json");
	assert.equal(await hasUsableCustomModel(), false);
});
