import type { TreeEntry } from "../../state/types";

/** The active @ token: replacement includes its suffix and optional closing quote. Offsets are UTF-16. */
export interface FileQuery {
	readonly start: number;
	readonly end: number;
	readonly query: string;
	readonly quoted: boolean;
	readonly token: string;
}

/**
 * The @path at a collapsed caret. Only line/word boundaries trigger it, not
 * email addresses or already-closed quoted references. Text after the caret
 * inside the token is replaced too, while surrounding prose remains intact.
 */
export function fileQuery(text: string, cursor: number): FileQuery | null {
	if (cursor < 0 || cursor > text.length) return null;
	const match = /(?:^|\s)@(?:"([^"\r\n\ufffc]*)|([^\s"@\ufffc]*))$/.exec(text.slice(0, cursor));
	if (!match) return null;
	const quoted = match[1] !== undefined;
	const query = match[1] ?? match[2];
	const start = cursor - query.length - (quoted ? 2 : 1);
	let end = cursor;
	if (quoted) {
		while (end < text.length && !/["\r\n\ufffc]/.test(text[end])) end += 1;
		if (text[end] === '"') end += 1;
	} else {
		while (end < text.length && !/[\s"@\ufffc]/.test(text[end])) end += 1;
	}
	return { start, end, query, quoted, token: text.slice(start, end) };
}

export interface FileCompletionText {
	readonly text: string;
	/** Caret offset inside the inserted text; a directory drill stays inside its quotes. */
	readonly cursor: number;
}

/** Enter references the entry; Tab/chevron on a directory keeps its @path open for the next level. */
export function fileCompletionText(entry: TreeEntry, quoted: boolean, drill: boolean): FileCompletionText {
	const directory = entry.kind === "directory";
	const path = `${entry.path}${directory ? "/" : ""}`;
	const needsQuotes = quoted || /[\s@]/.test(path);
	const mention = needsQuotes ? `@"${path}"` : `@${path}`;
	const continuing = directory && drill;
	const text = `${mention}${continuing ? "" : " "}`;
	return { text, cursor: text.length - (continuing && needsQuotes ? 1 : 0) };
}

/** Query identity, independent of a React render or a host response. */
export function sameFileQuery(left: FileQuery | null, right: FileQuery | null): boolean {
	return (
		left === right ||
		Boolean(
			left &&
				right &&
				left.start === right.start &&
				left.end === right.end &&
				left.query === right.query &&
				left.quoted === right.quoted &&
				left.token === right.token,
		)
	);
}
