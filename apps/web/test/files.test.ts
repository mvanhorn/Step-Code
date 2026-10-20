import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	containedWorkspacePath,
	listDirectory,
	MAX_PREVIEW_BYTES,
	readWorkspaceFile,
	searchWorkspaceFiles,
} from "../src/files.ts";

async function workspace(): Promise<{ root: string; outside: string; cleanup: () => Promise<void> }> {
	const base = await mkdtemp(join(tmpdir(), "stepcode-web-files-"));
	const root = join(base, "workspace");
	const outside = join(base, "outside");
	await mkdir(join(root, "src", "nested"), { recursive: true });
	await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
	await mkdir(outside);
	await writeFile(join(root, "README.md"), "# hello\n");
	await writeFile(join(root, ".gitignore"), "dist\n");
	await writeFile(join(root, "src", "app.ts"), "export const answer = 42;\n");
	await writeFile(join(root, "src", "nested", "deep-app.ts"), "export {};\n");
	await writeFile(join(root, "node_modules", "pkg", "app.js"), "module.exports = {};\n");
	await writeFile(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	await writeFile(join(root, "blob.bin"), Buffer.from([1, 2, 0, 3]));
	await writeFile(join(outside, "secret.txt"), "secret\n");
	return { root, outside, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test("a directory lists one level, directories first, dotfiles included", async () => {
	const { root, cleanup } = await workspace();
	try {
		const top = await listDirectory(root, "");
		assert.deepEqual(
			top.entries.map((entry) => `${entry.kind}:${entry.path}`),
			[
				"directory:node_modules",
				"directory:src",
				"file:.gitignore",
				"file:blob.bin",
				"file:logo.png",
				"file:README.md",
			],
		);
		assert.equal(top.truncated, false);
		const nested = await listDirectory(root, "src");
		assert.deepEqual(
			nested.entries.map((entry) => entry.path),
			["src/nested", "src/app.ts"],
		);
	} finally {
		await cleanup();
	}
});

test("paths that leave the workspace are refused, including through a symlink", async () => {
	const { root, outside, cleanup } = await workspace();
	try {
		await assert.rejects(containedWorkspacePath(root, "../outside/secret.txt"), /outside the workspace/);
		await assert.rejects(readWorkspaceFile(root, join(outside, "secret.txt")), /outside the workspace/);
		await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
		await assert.rejects(listDirectory(root, "escape"), /outside the workspace/);
		await assert.rejects(readWorkspaceFile(root, "escape/secret.txt"), /outside the workspace/);
		// A sibling whose name merely starts with the workspace name is still outside.
		await assert.rejects(containedWorkspacePath(root, "../workspace-other"), /./);
	} finally {
		await cleanup();
	}
});

test("a file is classified as text, image, binary or too large", async () => {
	const { root, cleanup } = await workspace();
	try {
		assert.deepEqual(await readWorkspaceFile(root, "src/app.ts"), {
			kind: "text",
			path: "src/app.ts",
			size: 26,
			content: "export const answer = 42;\n",
		});
		assert.deepEqual(await readWorkspaceFile(root, "logo.png"), {
			kind: "image",
			path: "logo.png",
			size: 4,
			mimeType: "image/png",
		});
		assert.equal((await readWorkspaceFile(root, "blob.bin")).kind, "binary");
		await writeFile(join(root, "big.log"), "x".repeat(MAX_PREVIEW_BYTES + 1));
		const big = await readWorkspaceFile(root, "big.log");
		assert.equal(big.kind, "too-large");
		assert.equal("content" in big, false);
		await assert.rejects(readWorkspaceFile(root, "src"), /not a file/);
	} finally {
		await cleanup();
	}
});

test("search matches names at any depth but does not descend into node_modules", async () => {
	const { root, cleanup } = await workspace();
	try {
		const found = await searchWorkspaceFiles(root, "APP");
		assert.deepEqual(
			found.entries.map((entry) => entry.path),
			["src/app.ts", "src/nested/deep-app.ts"],
		);
		assert.equal(found.truncated, false);
		assert.deepEqual((await searchWorkspaceFiles(root, "  ")).entries, []);
		const limited = await searchWorkspaceFiles(root, "app", 1);
		assert.equal(limited.entries.length, 1);
		assert.equal(limited.truncated, true);
		// The directory itself is still a match; only its contents are skipped.
		assert.deepEqual(
			(await searchWorkspaceFiles(root, "node_mod")).entries.map((entry) => entry.kind),
			["directory"],
		);
	} finally {
		await cleanup();
	}
});
