/**
 * One-time import of a local stepgo launcher's providers and key.
 *
 * Every path is passed explicitly and `env` is empty, so neither the
 * developer's `~/.stepgo` nor their `~/.stepcode` is read or written.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { importStepgoModels, type StepgoModelImportOptions } from "../src/stepgo-import.ts";

const FAKE_KEY = "ak-test-fixture-not-a-real-key";
const roots: string[] = [];

test.after(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Fixture {
	readonly options: StepgoModelImportOptions;
	readonly stepgoHome: string;
	readonly modelsPath: string;
	readonly authPath: string;
	readonly statePath: string;
}

async function fixture(): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "stepgo-import-"));
	roots.push(root);
	const stepgoHome = join(root, "stepgo");
	const modelsPath = join(root, "stepcode", "models.json");
	const authPath = join(root, "stepcode", "auth.json");
	const statePath = join(root, "stepcode", "agent", "stepgo-model-import.json");
	return {
		stepgoHome,
		modelsPath,
		authPath,
		statePath,
		options: { env: {}, stepgoHome, modelsPath, authPath, statePath, now: () => new Date(0) },
	};
}

async function writeStepgo(
	stepgoHome: string,
	managed: unknown,
	config: unknown = { model: "config", apiKey: FAKE_KEY, baseUrl: "https://gateway.example" },
): Promise<void> {
	await mkdir(join(stepgoHome, "config", "agent", "managed"), { recursive: true });
	await writeFile(join(stepgoHome, "config", "config.json"), JSON.stringify(config));
	if (managed !== undefined) {
		await writeFile(join(stepgoHome, "config", "agent", "managed", "config.json"), JSON.stringify(managed));
	}
}

const MANAGED = {
	providers: {
		"stepcode-chat": {
			api: "openai-completions",
			baseUrl: "https://gateway.example/v1",
			models: [
				{
					id: "deepseek-v4",
					model: "deepseek-v4",
					tokens: { maxContext: 1_000_000, maxOutput: 128_000 },
					input: ["text", "image"],
					reasoning: true,
					thinkingLevelMap: { off: null, high: "high" },
				},
			],
		},
		"stepcode-anthropic": {
			api: "anthropic-messages",
			baseUrl: "https://gateway.example/v1",
			models: [
				{
					id: "claude-opus",
					model: "claude-opus",
					tokens: { maxContext: 1_000_000, maxOutput: 64_000 },
					input: ["text"],
					reasoning: true,
					compat: { forceAdaptiveThinking: true },
				},
			],
		},
	},
	session: { trace: { headerInjectionBaseUrls: ["https://gateway.example/v1"] } },
	activeModel: "claude-opus",
};

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

test("stepgo import writes one declaration per provider and the shared key per provider id", async () => {
	const f = await fixture();
	await writeStepgo(f.stepgoHome, MANAGED);

	const result = await importStepgoModels(f.options);

	assert.deepEqual(result, {
		status: "imported",
		providers: ["stepcode-anthropic", "stepcode-chat"],
		existing: [],
		credentials: ["stepcode-anthropic", "stepcode-chat"],
		warnings: [],
	});
	const providers = readJson(f.modelsPath).providers as Record<string, Record<string, unknown>>;
	assert.deepEqual(providers["stepcode-chat"], {
		baseUrl: "https://gateway.example/v1",
		api: "openai-completions",
		models: [
			{
				id: "deepseek-v4",
				contextWindow: 1_000_000,
				maxTokens: 128_000,
				input: ["text", "image"],
				reasoning: true,
				thinkingLevelMap: { off: null, high: "high" },
			},
		],
	});
	// The Anthropic SDK appends /v1 itself, so the stored root drops it.
	assert.equal(providers["stepcode-anthropic"]?.baseUrl, "https://gateway.example");
	assert.deepEqual((providers["stepcode-anthropic"]?.models as Record<string, unknown>[])[0]?.compat, {
		forceAdaptiveThinking: true,
	});
	assert.ok(!readFileSync(f.modelsPath, "utf8").includes(FAKE_KEY), "models.json never holds the key");

	const auth = readJson(f.authPath);
	assert.deepEqual(auth["stepcode-chat"], { type: "api_key", key: FAKE_KEY });
	assert.deepEqual(auth["stepcode-anthropic"], { type: "api_key", key: FAKE_KEY });

	assert.deepEqual(readJson(f.statePath), {
		version: 1,
		importedAt: new Date(0).toISOString(),
		providers: ["stepcode-anthropic", "stepcode-chat"],
	});
});

test("stepgo import runs once: later stepgo changes and user edits are left alone", async () => {
	const f = await fixture();
	await writeStepgo(f.stepgoHome, MANAGED);
	await importStepgoModels(f.options);

	// The user deletes a provider; stepgo later rotates its key.
	const document = readJson(f.modelsPath);
	delete (document.providers as Record<string, unknown>)["stepcode-chat"];
	await writeFile(f.modelsPath, JSON.stringify(document));
	await writeStepgo(f.stepgoHome, MANAGED, { apiKey: "ak-rotated", baseUrl: "https://gateway.example" });

	assert.deepEqual(await importStepgoModels(f.options), { status: "done" });
	assert.deepEqual(Object.keys(readJson(f.modelsPath).providers as object), ["stepcode-anthropic"]);
	assert.deepEqual(readJson(f.authPath)["stepcode-anthropic"], { type: "api_key", key: FAKE_KEY });
});

test("stepgo import never replaces an existing declaration or credential", async () => {
	const f = await fixture();
	await mkdir(join(f.modelsPath, ".."), { recursive: true });
	const own = { baseUrl: "https://mine.example/v1", api: "openai-completions", models: [{ id: "mine" }] };
	await writeFile(f.modelsPath, JSON.stringify({ providers: { "stepcode-chat": own } }));
	await writeFile(
		f.authPath,
		JSON.stringify({
			step: { type: "oauth", access: "a", refresh: "r", expires: 1 },
			"stepcode-anthropic": { type: "api_key", key: "ak-user" },
		}),
	);
	await writeStepgo(f.stepgoHome, MANAGED);

	const result = await importStepgoModels(f.options);

	assert.equal(result.status, "imported");
	if (result.status !== "imported") return;
	assert.deepEqual(result.providers, ["stepcode-anthropic"]);
	assert.deepEqual(result.existing, ["stepcode-chat"]);
	assert.deepEqual(result.credentials, []);
	assert.deepEqual((readJson(f.modelsPath).providers as Record<string, unknown>)["stepcode-chat"], own);
	const auth = readJson(f.authPath);
	assert.deepEqual(auth["stepcode-anthropic"], { type: "api_key", key: "ak-user" });
	assert.equal(auth["stepcode-chat"], undefined);
	assert.equal((auth.step as Record<string, unknown>).type, "oauth");
});

test("stepgo import writes nothing without stepgo, and the next start tries again", async () => {
	const f = await fixture();

	assert.deepEqual(await importStepgoModels(f.options), { status: "skipped", reason: "stepgo is not installed" });
	assert.equal(existsSync(f.modelsPath), false);
	assert.equal(existsSync(f.statePath), false);

	await writeStepgo(f.stepgoHome, MANAGED);
	assert.equal((await importStepgoModels(f.options)).status, "imported");
});

test("stepgo import skips unreadable sources, the account id and unsupported dialects without throwing", async () => {
	const f = await fixture();
	await mkdir(join(f.stepgoHome, "config", "agent", "managed"), { recursive: true });
	await writeFile(join(f.stepgoHome, "config", "agent", "managed", "config.json"), "{ truncated");
	assert.equal((await importStepgoModels(f.options)).status, "skipped");

	await writeStepgo(f.stepgoHome, {
		providers: {
			step: { api: "openai-completions", baseUrl: "https://x.example/v1", models: [{ id: "a" }] },
			odd: { api: "bedrock-converse", baseUrl: "https://x.example", models: [{ id: "b" }] },
			ok: { api: "openai-responses", baseUrl: "https://x.example/v1", models: [{ id: "c" }, { id: "c" }] },
		},
	});
	const result = await importStepgoModels(f.options);
	assert.equal(result.status, "imported");
	if (result.status !== "imported") return;
	assert.deepEqual(result.providers, ["ok"]);
	assert.equal(result.warnings.length, 2);
	const providers = readJson(f.modelsPath).providers as Record<string, { models: unknown[] }>;
	assert.deepEqual(Object.keys(providers), ["ok"]);
	assert.deepEqual(providers.ok?.models, [{ id: "c" }]);
});

test("stepgo import can be switched off", async () => {
	const f = await fixture();
	await writeStepgo(f.stepgoHome, MANAGED);
	assert.deepEqual(await importStepgoModels({ ...f.options, env: { STEPCODE_STEPGO_IMPORT: "0" } }), {
		status: "disabled",
	});
	assert.equal(existsSync(f.modelsPath), false);
});
