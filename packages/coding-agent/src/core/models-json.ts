/**
 * Locked read-modify-write access to the user's `models.json`.
 *
 * The file belongs to the user: it is hand-edited (`docs/models.md`), and a
 * configuration surface writes it too. So a write here is the narrowest one that
 * can express the change — one provider replaced or removed — performed under
 * the settings lock, on top of the document as it exists at that moment, with
 * every other key preserved. Re-serializing the whole file from a snapshot taken
 * earlier would silently drop whatever the user edited in between.
 *
 * Two details of the format survive a write because they are part of the file as
 * the user maintains it:
 *
 * - `//` line comments and trailing commas parse (see `stripJsonComments`), and
 *   the leading comment block is re-emitted above the document.
 * - The file is written mode 0600 through a temporary file and a rename, so a
 *   reader never sees a half-written document.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stripJsonComments } from "../utils/json.ts";
import { normalizePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { validateModelsJsonProvider } from "./model-config.ts";
import { acquireSettingsLockSync } from "./settings-manager.ts";

/** The document as this module reads it: a JSON object, unknown keys included. */
export type ModelsJsonDocument = Record<string, unknown>;

/** A caller mistake a configuration surface reports as 4xx rather than a crash. */
export class ModelsJsonError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read the leading `//` comment block. Re-serializing JSON loses every comment,
 * so at minimum the header a user (or a template) put at the top survives.
 */
function leadingComments(text: string): string {
	const kept: string[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("//")) kept.push(line);
		else if (trimmed.length === 0 && kept.length > 0) kept.push(line);
		else break;
	}
	while (kept.length > 0 && kept[kept.length - 1]!.trim().length === 0) kept.pop();
	return kept.length > 0 ? `${kept.join("\n")}\n` : "";
}

/** The file's text, or `undefined` when it does not exist. */
function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new ModelsJsonError(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function parseDocument(path: string, content: string | undefined): ModelsJsonDocument {
	if (!content || !content.trim()) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(stripBom(content)));
	} catch (error) {
		throw new ModelsJsonError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed)) throw new ModelsJsonError(`${path} must contain a JSON object`);
	return parsed;
}

/** The parsed document, `{}` when the file does not exist yet. */
export function readModelsJson(path: string): ModelsJsonDocument {
	const normalized = normalizePath(path);
	return parseDocument(normalized, readText(normalized));
}

/** Every `providers.<id>` declaration, in file order. */
export function readModelsJsonProviders(path: string): Record<string, Record<string, unknown>> {
	const providers = readModelsJson(path).providers;
	if (!isRecord(providers)) return {};
	const result: Record<string, Record<string, unknown>> = {};
	for (const [id, config] of Object.entries(providers)) {
		if (isRecord(config)) result[id] = config;
	}
	return result;
}

function writeDocument(path: string, header: string, document: ModelsJsonDocument): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${header}${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, path);
}

/**
 * `proper-lockfile` locks an existing file, so a first write has to create it
 * before the critical section begins. An empty document is what "no file yet"
 * already means to every reader, so nothing is lost if the write then fails.
 */
function ensureFile(path: string): void {
	if (existsSync(path)) return;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	try {
		writeFileSync(path, "{}\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

/**
 * Read-modify-write the document under the settings lock, replacing exactly one
 * provider entry and leaving every other key as it was found.
 *
 * `update` returns the new declaration, or `undefined` to remove the entry. It
 * receives the document read inside the critical section, so a caller can
 * decide from the current state (whether the entry exists, what it held) rather
 * than from a snapshot taken before the lock. What it returns is checked against
 * the loader's own schema: a surface must not be able to write a declaration
 * that makes the next load fail.
 *
 * Every writer shares one lock file per document, so a concurrent hand edit
 * serializes with this write rather than being overwritten by it.
 */
export function updateModelsJsonProvider(
	path: string,
	providerId: string,
	update: (existing: Record<string, unknown> | undefined, document: ModelsJsonDocument) => unknown,
): void {
	const normalized = normalizePath(path);
	ensureFile(normalized);
	const release = acquireSettingsLockSync(normalized);
	try {
		const content = readText(normalized);
		const document = parseDocument(normalized, content);
		const providers = isRecord(document.providers) ? document.providers : {};
		const next = update(isRecord(providers[providerId]) ? providers[providerId] : undefined, document);
		const mergedProviders: Record<string, unknown> = { ...providers };
		if (next === undefined) {
			delete mergedProviders[providerId];
		} else {
			const errors = validateModelsJsonProvider(next);
			if (errors.length > 0) {
				throw new ModelsJsonError(`Provider '${providerId}' is not valid: ${errors.join("; ")}`);
			}
			mergedProviders[providerId] = next;
		}
		writeDocument(normalized, leadingComments(content ?? ""), { ...document, providers: mergedProviders });
	} finally {
		release();
	}
}
