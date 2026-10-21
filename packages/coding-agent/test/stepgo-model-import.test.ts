import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { importStepgoModels, type StepgoModelImportOptions } from "../src/step/stepgo-model-import.ts";

const FAKE_KEY = "ak-test-fixture-not-a-real-key";
const roots: string[] = [];

afterEach(async () => {
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
		// An empty env keeps the developer's STEPCODE_STEPGO_IMPORT and HOME out of the run.
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

describe("stepgo model import", () => {
	test("writes one declaration per provider and the shared key per provider id", async () => {
		const f = await fixture();
		await writeStepgo(f.stepgoHome, MANAGED);

		const result = await importStepgoModels(f.options);

		expect(result).toEqual({
			status: "imported",
			providers: ["stepcode-anthropic", "stepcode-chat"],
			existing: [],
			credentials: ["stepcode-anthropic", "stepcode-chat"],
			warnings: [],
		});
		const providers = readJson(f.modelsPath).providers as Record<string, Record<string, unknown>>;
		expect(providers["stepcode-chat"]).toEqual({
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
		// The Anthropic SDK appends /v1 itself, so the root drops it.
		expect(providers["stepcode-anthropic"]?.baseUrl).toBe("https://gateway.example");
		expect(readFileSync(f.modelsPath, "utf8")).not.toContain(FAKE_KEY);

		const auth = readJson(f.authPath);
		expect(auth["stepcode-chat"]).toEqual({ type: "api_key", key: FAKE_KEY });
		expect(auth["stepcode-anthropic"]).toEqual({ type: "api_key", key: FAKE_KEY });

		// What was written loads through the kernel's own schema.
		const loaded = await ModelConfig.load(f.modelsPath);
		expect(loaded.getError()).toBeUndefined();

		expect(readJson(f.statePath)).toEqual({
			version: 1,
			importedAt: new Date(0).toISOString(),
			providers: ["stepcode-anthropic", "stepcode-chat"],
		});
	});

	test("runs once: later changes in stepgo and user edits are left alone", async () => {
		const f = await fixture();
		await writeStepgo(f.stepgoHome, MANAGED);
		await importStepgoModels(f.options);

		// The user deletes a provider; stepgo later rotates its key.
		const document = readJson(f.modelsPath);
		delete (document.providers as Record<string, unknown>)["stepcode-chat"];
		await writeFile(f.modelsPath, JSON.stringify(document));
		await writeStepgo(f.stepgoHome, MANAGED, { apiKey: "ak-rotated", baseUrl: "https://gateway.example" });

		expect(await importStepgoModels(f.options)).toEqual({ status: "done" });
		expect(Object.keys(readJson(f.modelsPath).providers as object)).toEqual(["stepcode-anthropic"]);
		expect(readJson(f.authPath)["stepcode-anthropic"]).toEqual({ type: "api_key", key: FAKE_KEY });
	});

	test("never replaces an existing declaration or credential", async () => {
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

		expect(result).toMatchObject({
			status: "imported",
			providers: ["stepcode-anthropic"],
			existing: ["stepcode-chat"],
			credentials: [],
		});
		const providers = readJson(f.modelsPath).providers as Record<string, unknown>;
		expect(providers["stepcode-chat"]).toEqual(own);
		const auth = readJson(f.authPath);
		expect(auth["stepcode-anthropic"]).toEqual({ type: "api_key", key: "ak-user" });
		expect(auth["stepcode-chat"]).toBeUndefined();
		expect(auth.step).toMatchObject({ type: "oauth" });
	});

	test("without stepgo nothing is written and the next start tries again", async () => {
		const f = await fixture();

		expect(await importStepgoModels(f.options)).toEqual({ status: "skipped", reason: "stepgo is not installed" });
		expect(existsSync(f.modelsPath)).toBe(false);
		expect(existsSync(f.statePath)).toBe(false);

		await writeStepgo(f.stepgoHome, MANAGED);
		expect(await importStepgoModels(f.options)).toMatchObject({ status: "imported" });
	});

	test("skips unreadable sources, the account id and unsupported dialects without throwing", async () => {
		const f = await fixture();
		await mkdir(join(f.stepgoHome, "config", "agent", "managed"), { recursive: true });
		await writeFile(join(f.stepgoHome, "config", "agent", "managed", "config.json"), "{ truncated");
		expect(await importStepgoModels(f.options)).toMatchObject({ status: "skipped" });

		await writeStepgo(f.stepgoHome, {
			providers: {
				step: { api: "openai-completions", baseUrl: "https://x.example/v1", models: [{ id: "a" }] },
				odd: { api: "bedrock-converse", baseUrl: "https://x.example", models: [{ id: "b" }] },
				ok: { api: "openai-responses", baseUrl: "https://x.example/v1", models: [{ id: "c" }, { id: "c" }] },
			},
		});
		const result = await importStepgoModels(f.options);
		expect(result).toMatchObject({ status: "imported", providers: ["ok"] });
		if (result.status !== "imported") throw new Error("unreachable");
		expect(result.warnings).toHaveLength(2);
		const providers = readJson(f.modelsPath).providers as Record<string, { models: unknown[] }>;
		expect(Object.keys(providers)).toEqual(["ok"]);
		expect(providers.ok?.models).toEqual([{ id: "c" }]);
	});

	test("can be switched off", async () => {
		const f = await fixture();
		await writeStepgo(f.stepgoHome, MANAGED);
		expect(await importStepgoModels({ ...f.options, env: { STEPCODE_STEPGO_IMPORT: "0" } })).toEqual({
			status: "disabled",
		});
		expect(existsSync(f.modelsPath)).toBe(false);
	});
});
