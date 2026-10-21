import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readSessionBranch } from "../../src/core/session-manager.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function file(lines: readonly string[]): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "read-session-branch-")));
	dirs.push(dir);
	const path = join(dir, "session.jsonl");
	writeFileSync(path, lines.join(""));
	return path;
}

const header = (version: number) =>
	`${JSON.stringify({ type: "session", version, id: "s1", timestamp: "2026-10-17T00:00:00.000Z", cwd: "/w" })}\n`;
const entry = (id: string, parentId: string | null, text: string) =>
	JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: "2026-10-17T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 0 },
	});

test("returns the branch to the last entry and leaves the file untouched", async () => {
	const path = file([
		header(3),
		`${entry("a", null, "root")}\n`,
		`${entry("b", "a", "abandoned")}\n`,
		`${entry("c", "a", "kept")}\n`,
		// A writer mid-append: the unfinished line is skipped, not repaired.
		entry("d", "c", "partial").slice(0, 20),
	]);
	const before = readFileSync(path, "utf8");
	const read = await readSessionBranch(path);
	expect(read?.header.id).toBe("s1");
	expect(read?.branch.map((item) => item.id)).toEqual(["a", "c"]);
	expect(readFileSync(path, "utf8")).toBe(before);
});

test("migrates an old session in memory only", async () => {
	const legacy = JSON.stringify({
		type: "message",
		timestamp: "2026-10-17T00:00:00.000Z",
		message: { role: "user", content: "v1", timestamp: 0 },
	});
	const path = file([header(1), `${legacy}\n`]);
	const before = readFileSync(path, "utf8");
	const read = await readSessionBranch(path);
	expect(read?.branch).toHaveLength(1);
	expect(typeof read?.branch[0]?.id).toBe("string");
	expect(readFileSync(path, "utf8")).toBe(before);
});

test("rejects a file that is not a session", async () => {
	expect(await readSessionBranch(file([`${entry("a", null, "x")}\n`]))).toBeUndefined();
});
