import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Files the composer received by paste or drop. A browser hands the page the
 * bytes and name of a pasted file but never its original path, so the host
 * keeps a copy the agent can read with its tools; the message names that copy.
 * Copies live in the OS temp directory, which the system cleans; the host does
 * not delete them because a later turn may still read them.
 */
export const UPLOADS_DIR = join(tmpdir(), "stepcode-web-uploads");

/** Pasted files above this are refused; they are copied whole before the agent sees them. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface SavedUpload {
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
	const directory = join(root, randomUUID());
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, name);
	await writeFile(path, Buffer.concat(chunks), { mode: 0o600 });
	return { path, name, size };
}
