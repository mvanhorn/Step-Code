/**
 * Model providers: the user's custom `models.json` declarations, as the settings
 * page manages them.
 *
 * Two files are involved and they hold different things. `models.json` owns the
 * declaration — address, protocol, catalog — and is a file users read, copy
 * between machines and paste into bug reports. `auth.json` owns the secret. This
 * module keeps that split, so a key typed in the form never lands in the file
 * that gets shared.
 */

import { join } from "node:path";
import {
	AuthStorage,
	type DiscoveredModel,
	discoverModels,
	ModelDiscoveryError,
	readModelsJsonProviders,
	readStoredCredential,
	resolveStepConfigRoot,
	updateModelsJsonProvider,
} from "@step-harness/coding-agent";
import { SettingsError } from "./settings.ts";

/**
 * A provider declared in `models.json`, as the models page lists it.
 *
 * Only custom declarations appear. The built-in catalog is not configurable and
 * this screen has no opinion about it; a provider the kernel ships is simply not
 * one of these rows.
 */
export interface WebModelProvider {
	readonly id: string;
	readonly name: string;
	readonly baseUrl: string;
	readonly api: string;
	readonly models: readonly WebModelEntry[];
	/** Where this provider's API key comes from; never the key itself. */
	readonly credential: "stored" | "configured" | "none";
}

/** One catalog entry of a provider, as `models.json` stores it. */
export interface WebModelEntry {
	readonly id: string;
	readonly name?: string;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	readonly input?: readonly ("text" | "image")[];
}

/** The provider id whose `auth.json` entry is the account login, not a custom key. */
const STEP_PROVIDER_ID = "step";

/** Provider ids a URL can address; the same shape `mcp_servers` names use. */
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/u;

/** Longest id accepted, so a URL segment and a settings key stay reasonable. */
const MAX_PROVIDER_ID = 64;

/** Protocols the form offers. The stored value is the schema identifier the kernel reads. */
export const MODEL_APIS: readonly string[] = ["openai-completions", "openai-responses", "anthropic-messages"];

/**
 * `models.json` sits beside `config.toml` and `auth.json` under the config root,
 * which a host may relocate through `STEP_CODING_AGENT_DIR`; recomputing it from
 * the home directory would write a second file the kernel never reads.
 */
function modelsJsonPath(): string {
	return join(resolveStepConfigRoot(), "models.json");
}

/** The credential file the kernel reads, honouring the host's own override. */
function modelsAuthPath(): string {
	return process.env.STEPCODE_AUTH_PATH?.trim() || join(resolveStepConfigRoot(), "auth.json");
}

function stringOf(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Provider ids that hold a stored credential.
 *
 * `AuthStorage.list` reports the id and type only, never a resolved key, so this
 * never reads a secret into a reply. An unreadable auth file reports every
 * provider as keyless, which is the safe direction: the row asks for a key, and
 * the editor can write one without disturbing what could not be read.
 */
async function storedCredentialIds(): Promise<Set<string>> {
	try {
		const entries = await AuthStorage.create(modelsAuthPath()).list();
		return new Set(entries.map((entry) => entry.providerId));
	} catch {
		return new Set();
	}
}

function entryOf(raw: unknown): WebModelEntry | undefined {
	if (!isRecord(raw)) return undefined;
	const id = stringOf(raw.id);
	if (!id) return undefined;
	const input = (Array.isArray(raw.input) ? raw.input : []).filter(
		(value): value is "text" | "image" => value === "text" || value === "image",
	);
	return {
		id,
		...(stringOf(raw.name) ? { name: stringOf(raw.name) } : {}),
		...(typeof raw.contextWindow === "number" && raw.contextWindow > 0 ? { contextWindow: raw.contextWindow } : {}),
		...(typeof raw.maxTokens === "number" && raw.maxTokens > 0 ? { maxTokens: raw.maxTokens } : {}),
		...(input.length > 0 ? { input } : {}),
	};
}

/** Every custom provider in `models.json`, sorted so the list is stable between reads. */
export async function listModelProviders(): Promise<WebModelProvider[]> {
	const stored = await storedCredentialIds();
	const providers: WebModelProvider[] = [];
	for (const [id, config] of Object.entries(readModelsJsonProviders(modelsJsonPath()))) {
		providers.push({
			id,
			name: stringOf(config.name) || id,
			baseUrl: stringOf(config.baseUrl),
			api: stringOf(config.api),
			models: (Array.isArray(config.models) ? config.models : [])
				.map(entryOf)
				.filter((entry): entry is WebModelEntry => entry !== undefined),
			credential: stored.has(id) ? "stored" : stringOf(config.apiKey) ? "configured" : "none",
		});
	}
	providers.sort((left, right) => left.id.localeCompare(right.id));
	return providers;
}

/** Validate an id from the client. */
export function checkProviderId(id: string): void {
	if (!PROVIDER_ID.test(id) || id.length > MAX_PROVIDER_ID) {
		throw new SettingsError(
			400,
			"Provider ID must use lowercase letters, digits, '.', '_' and '-', and start with one",
		);
	}
	if (id === STEP_PROVIDER_ID) {
		throw new SettingsError(400, `'${STEP_PROVIDER_ID}' is the account provider and cannot be redefined`);
	}
}

/** A positive whole number, or `undefined`; anything else is the caller's mistake. */
function positiveInt(value: unknown, field: string): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new SettingsError(400, `${field} must be a positive whole number`);
	}
	return value;
}

/** The model catalog from the client: an id per row is required, the rest is optional. */
function parseModelEntries(input: unknown): Array<Record<string, unknown>> {
	if (input === undefined) return [];
	if (!Array.isArray(input)) throw new SettingsError(400, "models must be an array");
	const seen = new Set<string>();
	return input.map((raw) => {
		if (!isRecord(raw)) throw new SettingsError(400, "every model must be an object");
		const id = stringOf(raw.id);
		if (!id) throw new SettingsError(400, "every model needs an id");
		if (seen.has(id)) throw new SettingsError(400, `duplicate model id '${id}'`);
		seen.add(id);
		const contextWindow = positiveInt(raw.contextWindow, `model '${id}' context window`);
		const maxTokens = positiveInt(raw.maxTokens, `model '${id}' max output tokens`);
		const input_ = (Array.isArray(raw.input) ? raw.input : []).filter(
			(value): value is "text" | "image" => value === "text" || value === "image",
		);
		const name = stringOf(raw.name);
		return {
			id,
			...(name ? { name } : {}),
			...(contextWindow === undefined ? {} : { contextWindow }),
			...(maxTokens === undefined ? {} : { maxTokens }),
			...(input_.length > 0 ? { input: input_ } : {}),
		};
	});
}

export interface ModelProviderInput {
	readonly name?: unknown;
	readonly baseUrl?: unknown;
	readonly api?: unknown;
	readonly apiKey?: unknown;
	readonly models?: unknown;
}

/**
 * Build the declaration `models.json` stores.
 *
 * The API key is deliberately not part of it. A secret belongs in `auth.json`,
 * while `models.json` is a file users copy between machines and paste into bug
 * reports; the schema would accept an `apiKey` here, and this page still keeps
 * it out.
 */
export function parseModelProvider(input: ModelProviderInput): Record<string, unknown> {
	const baseUrl = stringOf(input.baseUrl);
	if (!baseUrl) throw new SettingsError(400, "API address is required");
	try {
		const parsed = new URL(baseUrl);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
	} catch {
		throw new SettingsError(400, "API address must be an http(s) URL");
	}
	const api = stringOf(input.api);
	if (!api) throw new SettingsError(400, "API protocol is required");
	const name = stringOf(input.name);
	const models = parseModelEntries(input.models);
	return {
		baseUrl,
		api,
		...(name ? { name } : {}),
		...(models.length > 0 ? { models } : {}),
	};
}

/**
 * Store (`key` set) or clear (`undefined`) one custom provider's API key.
 *
 * The entry is keyed by the provider id because that is the exact lookup the
 * kernel performs to resolve a request's auth — a composite name would leave the
 * key unreachable for both this page and a session. What keeps the account login
 * safe is the guard, not the spelling: `step` is refused, and an entry that is
 * not an api-key credential is never read or written here.
 */
export async function setStoredApiKey(id: string, key: string | undefined): Promise<void> {
	checkProviderId(id);
	const path = modelsAuthPath();
	const storage = AuthStorage.create(path);
	const existing = readStoredCredential(id, path);
	if (existing && existing.type !== "api_key") {
		throw new SettingsError(409, `Provider '${id}' is signed in; its credential is not an API key`);
	}
	if (key === undefined) {
		if (existing) await storage.delete(id);
		return;
	}
	await storage.modify(id, async () => ({ type: "api_key", key }));
}

/**
 * Create (`replace: false`, 409 when taken) or replace (`replace: true`, 404 when
 * missing) one provider, and store the key typed beside it.
 *
 * The declaration is written first and the credential second: a key with no
 * provider would be invisible and unusable, whereas a provider with no key is a
 * state the page already shows and the user can repair by editing. So a failed
 * credential write leaves a visible row rather than a stray secret.
 *
 * A stored key is write-only for this page — it is never sent back to the
 * browser — so a blank field means "leave it as it is" rather than "remove it".
 * `options.removeKey` is the explicit removal the editor sends when the user
 * asks for one; a typed key always wins over it.
 */
export async function saveModelProvider(
	id: string,
	input: ModelProviderInput,
	options: { replace: boolean; removeKey?: boolean },
): Promise<void> {
	checkProviderId(id);
	const declaration = parseModelProvider(input);
	const key = stringOf(input.apiKey);
	updateModelsJsonProvider(modelsJsonPath(), id, (existing) => {
		if (options.replace && !existing) throw new SettingsError(404, `Model provider '${id}' does not exist`);
		if (!options.replace && existing) throw new SettingsError(409, `Model provider '${id}' already exists`);
		// A hand-written literal key stays where it is: this form never displays it,
		// so replacing the declaration must not drop it. Only the key the page owns
		// (in auth.json) is managed here.
		const keepKey = existing?.apiKey === undefined ? {} : { apiKey: existing.apiKey };
		return { ...keepKey, ...declaration };
	});
	if (key) await setStoredApiKey(id, key);
	else if (options.removeKey) await setStoredApiKey(id, undefined);
}

/** Remove one provider and the key this page stored for it. */
export async function deleteModelProvider(id: string): Promise<void> {
	checkProviderId(id);
	updateModelsJsonProvider(modelsJsonPath(), id, (existing) => {
		if (!existing) throw new SettingsError(404, `Model provider '${id}' does not exist`);
		return undefined;
	});
	// Only an api-key credential this page could have written is cleared; an
	// account login for the same id would not be an api_key entry.
	await setStoredApiKey(id, undefined);
}

export interface DiscoverModelsInput {
	readonly baseUrl?: unknown;
	readonly api?: unknown;
	readonly apiKey?: unknown;
}

/**
 * Ask one endpoint which models it advertises, for the form's 获取可用模型 action.
 *
 * Nothing is stored: this answers for a declaration the user is still editing, so
 * a provider can be filled in and saved in one pass instead of save-then-return.
 * The key, when given, is used for this request only.
 *
 * A failure keeps the endpoint's own words where the protocol reported them (an
 * HTTP status, a JSON parse failure), and maps the rest to a 4xx that names what
 * the user can change: the address, the protocol, or the key.
 */
export async function discoverProviderModels(input: DiscoverModelsInput): Promise<DiscoveredModel[]> {
	try {
		return await discoverModels({
			api: stringOf(input.api) || undefined,
			baseUrl: stringOf(input.baseUrl),
			apiKey: stringOf(input.apiKey) || undefined,
		});
	} catch (error) {
		if (error instanceof ModelDiscoveryError) {
			const status = error.code === "http" ? 502 : 400;
			throw new SettingsError(status, error.message);
		}
		throw error;
	}
}
