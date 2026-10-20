import { type ArtifactKind, artifactKind, workspaceFilePath, workspaceFileReference } from "../../lib/file-references";
import { basename } from "../../lib/format";
import { markdownFileReferences } from "../../lib/markdown";
import type { TimelineItem } from "../../state/types";
import type { TurnFooter } from "./turn-footers";

export interface TurnArtifact {
	readonly path: string;
	readonly label: string;
	readonly kind: ArtifactKind;
}

// Streaming updates regroup history; unchanged settled turns must not reparse Markdown each frame.
const artifactCache = new Map<string, readonly TurnArtifact[]>();

/** Recognize references and observed outputs, not a durable or filesystem-verified registry. */
export function turnArtifacts(
	items: readonly TimelineItem[],
	footer: TurnFooter,
	cwd: string,
): readonly TurnArtifact[] {
	const start = items.findIndex(
		(item) => item.kind === "message" && item.role === "user" && (item.entryId ?? item.itemId) === footer.turnId,
	);
	const outputs = new Map<string, string>();
	const windows = /^[a-z]:[\\/]/i.test(cwd);
	const keyOf = (path: string) => (windows ? path.toLowerCase() : path);
	for (let index = Math.max(0, start); index <= footer.lastIndex; index++) {
		const item = items[index];
		if (item.kind !== "tool" || item.state !== "completed") continue;
		if (!["edit", "write", "edit_file", "write_file", "apply_patch"].includes(item.toolName)) continue;
		const raw = item.change?.path ?? item.args?.path;
		const path = raw ? workspaceFilePath(cwd, raw) : undefined;
		if (path && artifactKind(path) !== "file" && outputs.size < 64) outputs.set(keyOf(path), path);
	}
	const found = new Map<string, TurnArtifact>();
	const add = (path: string, label: string) => {
		if (found.size >= 12 || artifactKind(path) === "file" || found.has(keyOf(path))) return;
		found.set(keyOf(path), { path, label: label.slice(0, 160) || basename(path), kind: artifactKind(path) });
	};
	const text = footer.messages
		.filter((message) => !message.error)
		.map((message) => message.content)
		.join("\n\n");
	const cacheKey = JSON.stringify([cwd, text, [...outputs.values()]]);
	const cached = artifactCache.get(cacheKey);
	if (cached) return cached;
	for (const reference of markdownFileReferences(text)) {
		let path = workspaceFileReference(cwd, reference.path);
		if (!path) continue;
		if (reference.inlineCode) {
			const referenceKey = keyOf(path);
			const exact = outputs.get(keyOf(path));
			const matches = path.includes("/")
				? []
				: [...outputs.values()].filter((output) => keyOf(basename(output)) === referenceKey);
			// Bare code-styled filenames alone do not prove that a file was delivered.
			path = path.includes("/") ? exact : matches.length === 1 ? matches[0] : undefined;
			if (!path) continue;
		}
		add(path, reference.inlineCode ? basename(path) : reference.label);
	}
	for (const path of outputs.values()) add(path, basename(path));
	const result = [...found.values()];
	if (artifactCache.size >= 32) {
		const oldest = artifactCache.keys().next().value;
		if (oldest !== undefined) artifactCache.delete(oldest);
	}
	artifactCache.set(cacheKey, result);
	return result;
}
