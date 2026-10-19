import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_INLINED_CHARS } from "./attachments.ts";

/**
 * Files the composer received by paste or drop. A browser hands the page the
 * bytes and name of a pasted file but never its original path, so the host
 * keeps a copy; a message that names the copy gets its content added by
 * `withUploadedFiles`. Copies live in the OS temp directory, which the system
 * cleans; the host does not delete them because a later turn may still read them.
 */
export const UPLOADS_DIR = join(tmpdir(), "stepcode-web-uploads");

/** Pasted files above this are refused; they are copied whole before the agent sees them. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface SavedUpload {
	/** The copy's directory name; a message refers to the upload by it. */
	readonly id: string;
	/** Absolute path of the stored copy. */
	readonly path: string;
	readonly name: string;
	readonly size: number;
}

export class UploadTooLargeError extends Error {
	constructor(limit: number) {
		super(`File exceeds the ${limit} byte limit`);
		this.name = "UploadTooLargeError";
	}
}

/** A message named an upload id this host never issued, or whose copy is gone. */
export class UploadNotFoundError extends Error {
	constructor(id: string) {
		super(`Uploaded file not found: ${id}`);
		this.name = "UploadNotFoundError";
	}
}

/**
 * The last path segment of `raw`, safe as a file name on every platform:
 * separators, control characters and characters Windows reserves become `_`,
 * and leading/trailing dots and spaces go so `..` cannot name a parent.
 */
export function uploadFileName(raw: string): string {
	const base = raw.split(/[\\/]/).pop() ?? "";
	const cleaned = base
		.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
		.replace(/^[.\s]+|[.\s]+$/g, "")
		.slice(0, 200);
	return cleaned || "file";
}

/**
 * Store `body` as `<root>/<id>/<name>`. The random directory keeps two
 * pastes of `image.png` apart while the file keeps its own name, which is what
 * the user and the model refer to. Reading stops at `limit` bytes.
 */
export async function saveUpload(
	body: AsyncIterable<Uint8Array>,
	rawName: string,
	root: string = UPLOADS_DIR,
	limit: number = MAX_UPLOAD_BYTES,
): Promise<SavedUpload> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of body) {
		const buffer = Buffer.from(chunk);
		size += buffer.length;
		if (size > limit) throw new UploadTooLargeError(limit);
		chunks.push(buffer);
	}
	const name = uploadFileName(rawName);
	const id = randomUUID();
	const directory = join(root, id);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, name);
	await writeFile(path, Buffer.concat(chunks), { mode: 0o600 });
	return { id, path, name, size };
}

const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The copy stored under `id`. Only a UUID is accepted, so a message can name
 * nothing outside `root`; the directory holds exactly the one file `saveUpload` wrote.
 */
export async function resolveUpload(id: string, root: string = UPLOADS_DIR): Promise<SavedUpload> {
	if (!UPLOAD_ID.test(id)) throw new UploadNotFoundError(id);
	const directory = join(root, id);
	let names: string[];
	try {
		names = await readdir(directory);
	} catch {
		throw new UploadNotFoundError(id);
	}
	if (names.length !== 1) throw new UploadNotFoundError(id);
	const path = join(directory, names[0]);
	const info = await stat(path);
	if (!info.isFile()) throw new UploadNotFoundError(id);
	return { id, path, name: names[0], size: info.size };
}

/** The file as text, or undefined when it is not UTF-8 (a NUL byte or an invalid sequence). */
function decodeText(bytes: Buffer): string | undefined {
	if (bytes.includes(0)) return undefined;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

function attribute(value: string | number): string {
	return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * One `<attached_file>` block: the content of a text file (cut at a line
 * boundary past `MAX_INLINED_CHARS`, saying where to continue), or, for any
 * other file, where to read it. The client hides these blocks in the user's
 * bubble (`lib/attached-files.ts`), so the format is a contract with it.
 */
export function attachedFileBlock(upload: SavedUpload, bytes: Buffer): string {
	const attributes = `name="${attribute(upload.name)}" path="${attribute(upload.path)}" bytes="${upload.size}"`;
	const text = decodeText(bytes);
	if (text === undefined) {
		return [
			`<attached_file ${attributes} type="binary">`,
			"This file is not text, so its content is not included. Read it from the path above with your tools when you need it (the read tool opens images; convert PDF, Office and archive files with a shell command). Do not modify this copy; copy it elsewhere first if you need to change it.",
			"</attached_file>",
		].join("\n");
	}
	let body = text.replace(/\n$/, "");
	if (body.length > MAX_INLINED_CHARS) {
		const cut = body.lastIndexOf("\n", MAX_INLINED_CHARS);
		const head = body.slice(0, cut > 0 ? cut : MAX_INLINED_CHARS);
		const shown = head.split("\n").length;
		const total = body.split("\n").length;
		body = `${head}\n[Showing lines 1-${shown} of ${total}. Read the rest from the path above with the read tool, offset=${shown + 1}.]`;
	}
	return `<attached_file ${attributes}>\n${body}\n</attached_file>`;
}

/** `text` followed by one block per upload, in the order given (duplicates once). */
export async function withUploadedFiles(
	text: string,
	ids: readonly string[],
	root: string = UPLOADS_DIR,
): Promise<string> {
	if (!ids.length) return text;
	const blocks: string[] = [];
	for (const id of new Set(ids)) {
		const upload = await resolveUpload(id, root);
		blocks.push(attachedFileBlock(upload, await readFile(upload.path)));
	}
	return [text, ...blocks].join("\n\n");
}
