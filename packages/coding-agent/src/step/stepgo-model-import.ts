/**
 * One-time import of the models and API key a local stepgo launcher injects
 * into Step, so Web and Desktop start with the same providers instead of asking
 * the user to type them. After the import the providers are ordinary custom
 * providers: the user maintains them from the model settings page, and stepgo
 * is never read again.
 *
 * stepgo (`sc`, `stepgo`, `stepcode`) keeps its own state under `~/.stepgo`:
 *
 * - `config/config.json` holds the user's gateway `baseUrl` and `apiKey`.
 * - `config/agent/managed/config.json` is what stepgo writes before a launch and
 *   hands to Step through `STEPCODE_CONFIG_PATH`: one provider per API dialect
 *   (`stepcode-chat`, `stepcode-responses`, `stepcode-anthropic`) with the
 *   discovered model catalog. It carries no key; stepgo passes the key through
 *   `STEP_API_KEY` instead.
 *
 * Each provider becomes a `models.json` declaration and its key an `api_key`
 * entry in `auth.json` under the same provider id, which is the id the kernel
 * resolves the credential by. The declaration never holds the key, matching how
 * the model settings page writes providers.
 *
 * Rules:
 *
 * - **The foreign files are read-only.** Nothing under `~/.stepgo` is written.
 * - **Once.** A marker file records a completed import; while it exists the
 *   import returns before touching stepgo's files. Without stepgo installed no
 *   marker is written, so a launcher installed later is still picked up once.
 * - **Never overwrite the user.** A provider id already declared in
 *   `models.json` and a credential already stored for an id are left as they
 *   are. The `step` account login is never written.
 * - **Never block startup.** Every failure is a `skipped` result or a warning;
 *   the function does not throw.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Api } from "@step-harness/providers";
import { AuthStorage, readStoredCredential } from "../core/auth-storage.ts";
import { readModelsJsonProviders, updateModelsJsonProvider } from "../core/models-json.ts";
import { normalizeProviderBaseUrl } from "../core/provider-base-url.ts";
import { stripBom } from "../utils/text.ts";
import { getStepAuthPath } from "./auth.ts";
import { resolveStepAgentDir, resolveStepConfigRoot, resolveStepHomeDir } from "./environment.ts";

/** Marker file, beside the session data, recording the completed import. */
export const STEPGO_MODEL_IMPORT_STATE_FILE = "stepgo-model-import.json";

/** Set to `0`, `false`, `off` or `no` to disable the import (tests, managed installs). */
export const STEPGO_MODEL_IMPORT_ENV = "STEPCODE_STEPGO_IMPORT";

/** The provider id that holds the account login; an import never writes it. */
const STEP_ACCOUNT_PROVIDER_ID = "step";

/** Dialects Step can serve; a provider with any other `api` is skipped. */
const SUPPORTED_APIS: ReadonlySet<string> = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const DISABLED_VALUES: ReadonlySet<string> = new Set(["0", "false", "off", "no"]);

/** Where the import reads and writes. Every path can be overridden for tests and embedders. */
export interface StepgoModelImportOptions {
	readonly env?: NodeJS.ProcessEnv;
	/** stepgo's home directory, default `$STEPGO_HOME`, then `~/.stepgo`. */
	readonly stepgoHome?: string;
	/** Step's `models.json`, default `<config root>/models.json`. */
	readonly modelsPath?: string;
	/** Step's `auth.json`, default {@link getStepAuthPath}. */
	readonly authPath?: string;
	/** The marker file, default `<agent dir>/stepgo-model-import.json`. */
	readonly statePath?: string;
	readonly now?: () => Date;
}

/** What one import run did. Never contains a key. */
export type StepgoModelImportResult =
	| { readonly status: "disabled" }
	/** Already imported once; stepgo was not read. */
	| { readonly status: "done" }
	/** Nothing to import yet (no stepgo, unreadable files); retried on the next start. */
	| { readonly status: "skipped"; readonly reason: string }
	| {
			readonly status: "imported";
			/** Providers written to `models.json`. */
			readonly providers: readonly string[];
			/** Providers left alone because `models.json` already declared them. */
			readonly existing: readonly string[];
			/** Providers whose key was stored in `auth.json`. */
			readonly credentials: readonly string[];
			/** Per-provider problems that did not stop the others. */
			readonly warnings: readonly string[];
	  };

interface ImportedModel {
	readonly id: string;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	readonly input?: readonly ("text" | "image")[];
	readonly reasoning?: boolean;
	readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
	readonly compat?: Readonly<Record<string, unknown>>;
}

interface ImportedProvider {
	readonly id: string;
	readonly api: Api;
	readonly baseUrl: string;
	readonly models: readonly ImportedModel[];
	readonly apiKey?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** stepgo's home, honouring its own override variables. */
export function resolveStepgoHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.STEPGO_HOME?.trim() || env.STEPCODE_HOME?.trim() || join(resolveStepHomeDir(env), ".stepgo");
}

/** A JSON object from disk, `undefined` when absent; a malformed file is reported to the caller. */
function readJsonObject(path: string): Record<string, unknown> | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const parsed: unknown = JSON.parse(stripBom(text));
	if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
	return parsed;
}

/**
 * The model fields the kernel reads. stepgo stores tokens as
 * `tokens.maxContext` / `tokens.maxOutput` and repeats the id as `model`;
 * `models.json` names them `contextWindow` / `maxTokens`.
 */
function translateModel(raw: unknown): ImportedModel | undefined {
	if (!isRecord(raw)) return undefined;
	const id = stringOf(raw.id) ?? stringOf(raw.model);
	if (!id) return undefined;
	const tokens = isRecord(raw.tokens) ? raw.tokens : {};
	const input = (Array.isArray(raw.input) ? raw.input : []).filter(
		(value): value is "text" | "image" => value === "text" || value === "image",
	);
	let thinkingLevelMap: Record<string, string | null> | undefined;
	if (isRecord(raw.thinkingLevelMap)) {
		const map: Record<string, string | null> = {};
		for (const level of THINKING_LEVELS) {
			const value = raw.thinkingLevelMap[level];
			if (typeof value === "string" || value === null) map[level] = value;
		}
		if (Object.keys(map).length > 0) thinkingLevelMap = map;
	}
	const contextWindow = positiveInt(tokens.maxContext) ?? positiveInt(raw.contextWindow);
	const maxTokens = positiveInt(tokens.maxOutput) ?? positiveInt(raw.maxTokens);
	return {
		id,
		...(contextWindow === undefined ? {} : { contextWindow }),
		...(maxTokens === undefined ? {} : { maxTokens }),
		...(input.length > 0 ? { input } : {}),
		...(typeof raw.reasoning === "boolean" ? { reasoning: raw.reasoning } : {}),
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		...(isRecord(raw.compat) ? { compat: raw.compat } : {}),
	};
}

/**
 * A literal provider-scoped key wins over the shared one. An environment
 * reference (`$NAME`) or a command (`!cmd`) is not a key and falls back to the
 * shared key, which is what stepgo itself sends.
 */
function providerKey(raw: Record<string, unknown>, sharedKey: string | undefined): string | undefined {
	const own = stringOf(raw.apiKey);
	if (own && !own.startsWith("$") && !own.startsWith("!")) return own;
	return sharedKey;
}

/** Read both stepgo files into the providers to import, or the reason there are none. */
function readStepgoProviders(stepgoHome: string): { providers: ImportedProvider[]; warnings: string[] } | string {
	const configPath = join(stepgoHome, "config", "config.json");
	const managedPath = join(stepgoHome, "config", "agent", "managed", "config.json");
	let config: Record<string, unknown> | undefined;
	let managed: Record<string, unknown> | undefined;
	try {
		config = readJsonObject(configPath);
		managed = readJsonObject(managedPath);
	} catch (error) {
		return `stepgo configuration is unreadable: ${error instanceof Error ? error.message : String(error)}`;
	}
	if (!managed) return config ? `${managedPath} does not exist yet` : "stepgo is not installed";
	if (!isRecord(managed.providers)) return `${managedPath} has no providers`;

	const sharedKey = stringOf(config?.apiKey);
	const providers: ImportedProvider[] = [];
	const warnings: string[] = [];
	for (const [id, raw] of Object.entries(managed.providers)) {
		if (!isRecord(raw)) continue;
		if (id === STEP_ACCOUNT_PROVIDER_ID) {
			warnings.push(`'${id}' is the account provider and was not imported`);
			continue;
		}
		const api = stringOf(raw.api);
		if (!api || !SUPPORTED_APIS.has(api)) {
			warnings.push(`'${id}' uses an unsupported API '${api ?? "(none)"}'`);
			continue;
		}
		const baseUrl = normalizeProviderBaseUrl(stringOf(raw.baseUrl) ?? stringOf(config?.baseUrl), api as Api);
		if (!baseUrl) {
			warnings.push(`'${id}' has no API address`);
			continue;
		}
		const seen = new Set<string>();
		const models: ImportedModel[] = [];
		for (const entry of Array.isArray(raw.models) ? raw.models : []) {
			const model = translateModel(entry);
			if (!model || seen.has(model.id)) continue;
			seen.add(model.id);
			models.push(model);
		}
		if (models.length === 0) {
			warnings.push(`'${id}' has no models`);
			continue;
		}
		const apiKey = providerKey(raw, sharedKey);
		providers.push({ id, api: api as Api, baseUrl, models, ...(apiKey ? { apiKey } : {}) });
	}
	providers.sort((left, right) => left.id.localeCompare(right.id));
	if (providers.length === 0) return warnings.length > 0 ? warnings.join("; ") : `${managedPath} has no providers`;
	return { providers, warnings };
}

function writeMarker(path: string, providers: readonly string[], now: Date): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	const content = { version: 1, importedAt: now.toISOString(), providers };
	writeFileSync(temporary, `${JSON.stringify(content, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, path);
}

/**
 * Store the imported key unless the id already holds a credential: an existing
 * key is the user's, and an OAuth entry is a login the user made.
 */
async function storeKey(storage: AuthStorage, authPath: string, provider: ImportedProvider): Promise<boolean> {
	const key = provider.apiKey;
	if (!key || readStoredCredential(provider.id, authPath)) return false;
	let stored = false;
	await storage.modify(provider.id, async (current) => {
		// Re-checked under the lock: another host may have written it meanwhile.
		if (current) return undefined;
		stored = true;
		return { type: "api_key", key };
	});
	return stored;
}

/** Whether the import is switched off through {@link STEPGO_MODEL_IMPORT_ENV}. */
export function isStepgoModelImportDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[STEPGO_MODEL_IMPORT_ENV]?.trim().toLowerCase();
	return value !== undefined && DISABLED_VALUES.has(value);
}

/**
 * Import stepgo's providers into `models.json` / `auth.json` once.
 *
 * After a completed import this only checks that the marker file exists. A run
 * where some provider failed to write records no marker, so the next start
 * retries; providers written by the earlier run are then already declared and
 * are left as they are.
 */
export async function importStepgoModels(options: StepgoModelImportOptions = {}): Promise<StepgoModelImportResult> {
	const env = options.env ?? process.env;
	if (isStepgoModelImportDisabled(env)) return { status: "disabled" };
	try {
		const statePath = options.statePath ?? join(resolveStepAgentDir(env), STEPGO_MODEL_IMPORT_STATE_FILE);
		if (existsSync(statePath)) return { status: "done" };

		const source = readStepgoProviders(options.stepgoHome ?? resolveStepgoHome(env));
		if (typeof source === "string") return { status: "skipped", reason: source };

		const modelsPath = options.modelsPath ?? join(resolveStepConfigRoot(env), "models.json");
		const authPath = options.authPath ?? getStepAuthPath(env);
		const declared = readModelsJsonProviders(modelsPath);
		const storage = AuthStorage.create(authPath);
		const warnings = [...source.warnings];
		const imported: string[] = [];
		const existing: string[] = [];
		const credentials: string[] = [];
		let failed = false;

		for (const provider of source.providers) {
			if (declared[provider.id]) {
				existing.push(provider.id);
				continue;
			}
			let written = false;
			try {
				updateModelsJsonProvider(modelsPath, provider.id, (current) => {
					// Under the lock: a concurrent host or the user may have created it.
					if (current) return current;
					written = true;
					return { baseUrl: provider.baseUrl, api: provider.api, models: provider.models.map((m) => ({ ...m })) };
				});
			} catch (error) {
				failed = true;
				warnings.push(
					`'${provider.id}' was not written: ${error instanceof Error ? error.message : String(error)}`,
				);
				continue;
			}
			if (written) imported.push(provider.id);
			else existing.push(provider.id);
			try {
				if (await storeKey(storage, authPath, provider)) credentials.push(provider.id);
			} catch (error) {
				failed = true;
				warnings.push(
					`'${provider.id}' key was not stored: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		if (!failed) writeMarker(statePath, imported, options.now?.() ?? new Date());
		return { status: "imported", providers: imported, existing, credentials, warnings };
	} catch (error) {
		return { status: "skipped", reason: error instanceof Error ? error.message : String(error) };
	}
}
