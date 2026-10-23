import { homedir } from "node:os";

/**
 * Collapse the user's home directory to `~`.
 *
 * A report is read by someone else, so an absolute path leaks the OS user name
 * on every line it appears. Collapsing keeps the path structure an investigator
 * needs (`~/code/app/src/main.ts`) without carrying who the user is. Matching
 * happens only at a path boundary, so `/Users/bob2` is not touched by a
 * `/Users/bob` prefix.
 */
export function collapseHomePaths(value: string, home?: string): string {
	const normalized = (home ?? homeDirectory()).replace(/[\\/]+$/u, "");
	if (normalized.length < 2) return value;
	const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	return value.replace(new RegExp(`${escaped}(?=[\\\\/]|$|["'\\s])`, "gu"), "~");
}

function homeDirectory(): string {
	try {
		return homedir();
	} catch {
		return "";
	}
}
