import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitBranch } from "../src/git-branch.ts";

async function scratch(): Promise<string> {
	return mkdtemp(join(tmpdir(), "stepcode-git-branch-"));
}

test("reads the branch from the nearest repository above cwd", async () => {
	const root = await scratch();
	try {
		await mkdir(join(root, ".git"));
		await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/feat/web-themes\n");
		await mkdir(join(root, "apps", "web"), { recursive: true });
		assert.equal(gitBranch(join(root, "apps", "web")), "feat/web-themes");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("follows a worktree's .git file and shortens a detached HEAD", async () => {
	const root = await scratch();
	try {
		const gitDir = join(root, "main", ".git", "worktrees", "wt");
		await mkdir(gitDir, { recursive: true });
		await writeFile(join(gitDir, "HEAD"), `${"a1b2c3d4e5".repeat(4)}\n`);
		await mkdir(join(root, "wt"));
		await writeFile(join(root, "wt", ".git"), "gitdir: ../main/.git/worktrees/wt\n");
		assert.equal(gitBranch(join(root, "wt")), "a1b2c3d");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("is undefined outside a repository or for an unreadable HEAD", async () => {
	const root = await scratch();
	try {
		await mkdir(join(root, "repo", ".git"), { recursive: true });
		await writeFile(join(root, "repo", ".git", "HEAD"), "not a head");
		assert.equal(gitBranch(join(root, "repo")), undefined);
		assert.equal(gitBranch(join(root, "missing", "deeper")), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
