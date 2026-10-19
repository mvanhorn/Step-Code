import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { saveUpload, UploadTooLargeError, uploadFileName } from "../src/uploads.ts";

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
	for (const part of parts) yield Buffer.from(part);
}

test("uploadFileName keeps the last segment and strips unsafe characters", () => {
	assert.equal(uploadFileName("latest.json"), "latest.json");
	assert.equal(uploadFileName("Markdown 文稿.html"), "Markdown 文稿.html");
	assert.equal(uploadFileName("../../etc/passwd"), "passwd");
	assert.equal(uploadFileName("C:\\Users\\me\\a:b?.txt"), "a_b_.txt");
	assert.equal(uploadFileName(".."), "file");
	assert.equal(uploadFileName(" .env "), "env");
	assert.equal(uploadFileName(""), "file");
});

test("saveUpload stores each upload under its own directory with the original name", async () => {
	const root = await mkdtemp(join(tmpdir(), "stepcode-uploads-test-"));
	try {
		const first = await saveUpload(chunks("{\"a\":", "1}"), "latest.json", root);
		const second = await saveUpload(chunks("x"), "latest.json", root);
		assert.equal(first.name, "latest.json");
		assert.equal(first.size, 7);
		assert.equal(await readFile(first.path, "utf8"), '{"a":1}');
		assert.notEqual(dirname(first.path), dirname(second.path));
		assert.equal(dirname(dirname(first.path)), root);
		if (process.platform !== "win32") assert.equal((await stat(first.path)).mode & 0o777, 0o600);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("saveUpload refuses a body over the limit without writing it", async () => {
	const root = await mkdtemp(join(tmpdir(), "stepcode-uploads-test-"));
	try {
		await assert.rejects(saveUpload(chunks("abc", "def"), "big.bin", root, 4), UploadTooLargeError);
		assert.deepEqual(await readdir(root), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
