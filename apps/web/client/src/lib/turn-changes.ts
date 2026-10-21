/**
 * Per-turn file changes, derived from the timeline. A turn runs from one user
 * message to the next; its changes are the successful edit/write calls in it,
 * each carrying the unified patch the tool recorded (`ToolTimelineItem.change`).
 * The host has its own copy of the patch reader for reverting
 * (src/turn-changes.ts); the two cannot share code.
 */

import type { TimelineItem, UntrackedReason } from "../state/types";

export interface DiffLine {
	readonly kind: "add" | "del" | "context" | "hunk";
	/** Line number in the new file (add, context) or the old file (del). */
	readonly number?: number;
	readonly text: string;
}

export interface ParsedPatch {
	readonly lines: readonly DiffLine[];
	readonly additions: number;
	readonly deletions: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Rows of a jsdiff unified patch. Hunks are counted, so a removed `--- x` line is not taken for a header. */
export function parsePatch(patch: string): ParsedPatch {
	const source = patch.split("\n");
	const lines: DiffLine[] = [];
	let additions = 0;
	let deletions = 0;
	let index = 0;
	while (index < source.length) {
		const header = HUNK_HEADER.exec(source[index] ?? "");
		index += 1;
		if (!header) continue;
		let oldNumber = Number(header[1]);
		let newNumber = Number(header[3]);
		let oldLeft = header[2] === undefined ? 1 : Number(header[2]);
		let newLeft = header[4] === undefined ? 1 : Number(header[4]);
		lines.push({ kind: "hunk", text: (source[index - 1] ?? "").trim() });
		while (index < source.length && (oldLeft > 0 || newLeft > 0 || source[index]?.startsWith("\\"))) {
			const line = source[index] ?? "";
			index += 1;
			const marker = line[0];
			const text = line.slice(1);
			if (marker === "\\") continue;
			if (marker === "+") {
				lines.push({ kind: "add", number: newNumber, text });
				newNumber += 1;
				newLeft -= 1;
				additions += 1;
			} else if (marker === "-") {
				lines.push({ kind: "del", number: oldNumber, text });
				oldNumber += 1;
				oldLeft -= 1;
				deletions += 1;
			} else {
				lines.push({ kind: "context", number: newNumber, text });
				oldNumber += 1;
				newNumber += 1;
				oldLeft -= 1;
				newLeft -= 1;
			}
		}
	}
	// A patch that creates or replaces a whole file needs no "@@" separator.
	if (lines[0]?.kind === "hunk" && !lines.slice(1).some((line) => line.kind === "hunk")) lines.shift();
	return { lines, additions, deletions };
}

export interface ChangedFile {
	/** Shown path: relative to the session folder when inside it. */
	readonly path: string;
	/** Patches in the order they were made. */
	readonly patches: readonly string[];
	/** A change of this file has no patch: it is not shown as a diff and undo skips it. */
	readonly untracked?: UntrackedReason;
	readonly additions: number;
	readonly deletions: number;
}

export interface TurnChanges {
	/** Entry id of the user message that opened the turn (the host's revert key). */
	readonly turnId: string;
	/** 1-based position among all turns of the session. */
	readonly ordinal: number;
	/** The turn is the session's latest. */
	readonly latest: boolean;
	/** Index of the turn's last timeline row; the card follows it. */
	readonly lastIndex: number;
	readonly files: readonly ChangedFile[];
	readonly additions: number;
	readonly deletions: number;
}

/** `path` relative to `cwd` when it lies inside it, without a leading `./`. */
export function displayPath(path: string, cwd: string): string {
	const root = cwd.replace(/[\\/]+$/, "");
	if (root && (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))) return path.slice(root.length + 1);
	return path.replace(/^\.[\\/]/, "");
}

/** `["dir/", "name"]` of a shown path. */
export function splitPath(path: string): readonly [string, string] {
	const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
	return [path.slice(0, cut), path.slice(cut)];
}

const patchStats = new Map<string, ParsedPatch>();

/** parsePatch, memoised: every stream frame regroups the timeline. */
export function parsedPatch(patch: string): ParsedPatch {
	let parsed = patchStats.get(patch);
	if (!parsed) {
		parsed = parsePatch(patch);
		if (patchStats.size > 500) patchStats.clear();
		patchStats.set(patch, parsed);
	}
	return parsed;
}

interface TurnDraft {
	readonly turnId: string;
	readonly ordinal: number;
	lastIndex: number;
	readonly files: Map<string, { patches: string[]; untracked?: UntrackedReason }>;
}

function sameFile(left: ChangedFile, right: ChangedFile): boolean {
	return (
		left.path === right.path &&
		left.untracked === right.untracked &&
		left.patches.length === right.patches.length &&
		left.patches.every((patch, index) => patch === right.patches[index])
	);
}

function sameTurn(left: TurnChanges, right: TurnChanges): boolean {
	return (
		left.ordinal === right.ordinal &&
		left.latest === right.latest &&
		left.lastIndex === right.lastIndex &&
		left.files.length === right.files.length &&
		left.files.every((file, index) => file === right.files[index])
	);
}

/** The last result per turn id: a stream frame regroups the timeline, unchanged turns keep their objects. */
let previousTurns = new Map<string, TurnChanges>();

/**
 * Turns that changed at least one file, oldest first. A turn or file whose
 * content did not change since the previous call is the same object, so
 * memoised cards and diffs skip re-rendering.
 */
export function collectTurnChanges(items: readonly TimelineItem[], cwd: string): TurnChanges[] {
	const turns: TurnDraft[] = [];
	let ordinal = 0;
	items.forEach((item, index) => {
		if (item.kind === "message" && item.role === "user") {
			ordinal += 1;
			turns.push({ turnId: item.entryId ?? item.itemId, ordinal, lastIndex: index, files: new Map() });
			return;
		}
		if (!turns.length) turns.push({ turnId: "", ordinal: 0, lastIndex: index, files: new Map() });
		const turn = turns[turns.length - 1];
		if (item.kind === "approval") return;
		turn.lastIndex = index;
		if (item.kind !== "tool") return;
		if (!item.change) return;
		const path = displayPath(item.change.path, cwd);
		const file = turn.files.get(path) ?? { patches: [] };
		if (item.change.patch !== undefined) file.patches.push(item.change.patch);
		else file.untracked ??= item.change.untracked ?? "unknown";
		turn.files.set(path, file);
	});
	const next = new Map<string, TurnChanges>();
	const result = turns
		.filter((turn) => turn.files.size && turn.turnId)
		.map((turn) => {
			const previous = previousTurns.get(turn.turnId);
			const files = [...turn.files].map(([path, { patches, untracked }]) => {
				let additions = 0;
				let deletions = 0;
				for (const patch of patches) {
					const parsed = parsedPatch(patch);
					additions += parsed.additions;
					deletions += parsed.deletions;
				}
				const file: ChangedFile = { path, patches, ...(untracked ? { untracked } : {}), additions, deletions };
				return previous?.files.find((candidate) => sameFile(candidate, file)) ?? file;
			});
			const changes: TurnChanges = {
				turnId: turn.turnId,
				ordinal: turn.ordinal,
				latest: turn.ordinal === ordinal,
				lastIndex: turn.lastIndex,
				files,
				additions: files.reduce((sum, file) => sum + file.additions, 0),
				deletions: files.reduce((sum, file) => sum + file.deletions, 0),
			};
			const kept = previous && sameTurn(previous, changes) ? previous : changes;
			next.set(turn.turnId, kept);
			return kept;
		});
	previousTurns = next;
	return result;
}
