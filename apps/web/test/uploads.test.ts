import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { markAttachedFiles, splitAttachedFiles } from "../client/src/lib/attached-files.ts";
import {
	attachedFileBlock,
	resolveUpload,
	saveUpload,
	UploadNotFoundError,
	UploadTooLargeError,
	uploadFileName,
	withUploadedFiles,
} from "../src/uploads.ts";

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
		assert.equal(dirname(first.path), join(root, first.id));
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

const upload = (name: string, size: number) => ({ id: "x", path: `/tmp/u/${name}`, name, size });

test("a text upload is inlined in an attached_file block", () => {
	const block = attachedFileBlock(upload("notes.md", 12), Buffer.from("# Title\nBody\n"));
	assert.equal(block, '<attached_file name="notes.md" path="/tmp/u/notes.md" bytes="12">\n# Title\nBody\n</attached_file>');
});

test("a long text upload is cut at a line and says where to continue", () => {
	const lines = Array.from({ length: 20_000 }, (_, index) => `line ${index + 1}`).join("\n");
	const block = attachedFileBlock(upload("big.log", lines.length), Buffer.from(lines));
	const shown = /\[Showing lines 1-(\d+) of 20000\. .*offset=(\d+)\.\]/.exec(block);
	assert.ok(shown, "continuation notice");
	assert.equal(Number(shown[2]), Number(shown[1]) + 1);
	assert.ok(block.includes(`line ${shown[1]}\n[Showing`));
	assert.ok(block.length < 41_000);
});

test("a binary upload gives the path to read instead of its bytes", () => {
	const block = attachedFileBlock(upload("report.pdf", 4), Buffer.from([0x25, 0x50, 0x00, 0xff]));
	assert.match(block, /^<attached_file name="report.pdf" path="\/tmp\/u\/report.pdf" bytes="4" type="binary">\n/);
	assert.doesNotMatch(block, /%P/);
	assert.match(block, /Read it from the path above/);
});

test("attribute values are escaped and read back by the client", () => {
	const block = attachedFileBlock(upload('a "b" <c> & d.txt', 1), Buffer.from("x"));
	const parsed = splitAttachedFiles(`look at a "b" <c> & d.txt\n\n${block}`);
	assert.equal(parsed.text, 'look at a "b" <c> & d.txt');
	assert.deepEqual(parsed.files, [{ name: 'a "b" <c> & d.txt', path: '/tmp/u/a "b" <c> & d.txt', bytes: 1 }]);
});

test("withUploadedFiles appends each named upload once, in order, and rejects unknown ids", async () => {
	const root = await mkdtemp(join(tmpdir(), "stepcode-uploads-test-"));
	try {
		const a = await saveUpload(chunks("AAA"), "a.txt", root);
		const b = await saveUpload(chunks("BBB"), "b.txt", root);
		const text = await withUploadedFiles("compare a.txt and b.txt", [b.id, a.id, b.id], root);
		assert.equal(text.match(/<attached_file /g)?.length, 2);
		assert.ok(text.indexOf("BBB") < text.indexOf("AAA"));
		const parsed = splitAttachedFiles(text);
		assert.equal(parsed.text, "compare a.txt and b.txt");
		assert.deepEqual(
			parsed.files.map((file) => file.name),
			["b.txt", "a.txt"],
		);
		assert.equal(await withUploadedFiles("plain", [], root), "plain");
		await assert.rejects(withUploadedFiles("x", ["../etc"], root), UploadNotFoundError);
		await assert.rejects(withUploadedFiles("x", ["00000000-0000-4000-8000-000000000000"], root), UploadNotFoundError);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("resolveUpload refuses a directory that does not hold exactly one file", async () => {
	const root = await mkdtemp(join(tmpdir(), "stepcode-uploads-test-"));
	try {
		const id = "11111111-2222-4333-8444-555555555555";
		await mkdir(join(root, id));
		await writeFile(join(root, id, "one"), "1");
		assert.equal((await resolveUpload(id, root)).name, "one");
		await writeFile(join(root, id, "two"), "2");
		await assert.rejects(resolveUpload(id, root), UploadNotFoundError);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("markAttachedFiles marks each file where its name stands, longest name first", () => {
	const file = (name: string) => ({ name, path: `/u/${name}`, bytes: 1 });
	const marked = markAttachedFiles("看看a.tar.gz和a.tar，再比较 a.tar.gz", [file("a.tar"), file("a.tar.gz")]);
	assert.equal(marked, "看看\u00021\u0002和\u00020\u0002，再比较 \u00021\u0002");
	assert.equal(markAttachedFiles("这是什么", [file("x.zip")]), "这是什么 \u00020\u0002");
	assert.equal(markAttachedFiles("stray \u0002 mark x.zip", [file("x.zip")]), "stray  mark \u00020\u0002");
	assert.equal(markAttachedFiles("plain", []), "plain");
});
