import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** A HEAD file is one short line; anything longer is not one we can read. */
const MAX_HEAD_BYTES = 1024;

/** The `.git` entry of the repository holding `cwd`: the nearest one at or above it. */
function findDotGit(cwd: string): string | undefined {
	let dir = resolve(cwd);
	for (;;) {
		const candidate = join(dir, ".git");
		try {
			statSync(candidate);
			return candidate;
		} catch {
			// Not here; keep walking up.
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function readSmall(path: string): string | undefined {
	const stats = statSync(path);
	if (!stats.isFile() || stats.size > MAX_HEAD_BYTES) return undefined;
	return readFileSync(path, "utf8").trim();
}

/**
 * The checked-out branch of the Git repository holding `cwd`, read from its HEAD file without
 * running `git`: `main` for a branch, the 7-character commit for a detached HEAD. A worktree's
 * `.git` file points at its own git dir, which holds that worktree's HEAD.
 *
 * Presentation only (the session header shows it), so any unreadable or unexpected layout yields
 * `undefined` rather than an error: the session works the same with or without it.
 */
export function gitBranch(cwd: string): string | undefined {
	try {
		const dotGit = findDotGit(cwd);
		if (!dotGit) return undefined;
		let gitDir = dotGit;
		if (statSync(dotGit).isFile()) {
			const pointer = readSmall(dotGit)?.match(/^gitdir:\s*(.+)$/);
			if (!pointer?.[1]) return undefined;
			gitDir = resolve(dirname(dotGit), pointer[1]);
		}
		const head = readSmall(join(gitDir, "HEAD"));
		if (!head) return undefined;
		const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
		if (ref?.[1]) return ref[1];
		return /^[0-9a-f]{40,64}$/.test(head) ? head.slice(0, 7) : undefined;
	} catch {
		return undefined;
	}
}
