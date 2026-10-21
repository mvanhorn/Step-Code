/**
 * Files the host appended to a user message (`src/uploads.ts`
 * `attachedFileBlock`): one `<attached_file name path bytes [type]>` block per
 * file after the user's own text. The model needs the blocks; the user's
 * bubble, the session title and search show only the text and the file names.
 */

export interface AttachedFile {
	readonly name: string;
	readonly path: string;
	readonly bytes: number;
}

export interface MessageWithFiles {
	/** The message without the blocks. */
	readonly text: string;
	readonly files: readonly AttachedFile[];
}

const BLOCK = /\n*<attached_file ([^>\n]*)>\n[\s\S]*?\n<\/attached_file>/g;
const ATTRIBUTE = /(\w+)="([^"]*)"/g;

function attributeValue(value: string): string {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&");
}

export function splitAttachedFiles(text: string): MessageWithFiles {
	if (!text.includes("<attached_file ")) return { text, files: [] };
	const files: AttachedFile[] = [];
	const rest = text.replace(BLOCK, (_match, attributes: string) => {
		const values = new Map<string, string>();
		for (const [, key, value] of attributes.matchAll(ATTRIBUTE)) values.set(key, attributeValue(value));
		files.push({
			name: values.get("name") ?? "",
			path: values.get("path") ?? "",
			bytes: Number(values.get("bytes") ?? 0),
		});
		return "";
	});
	return { text: rest.trimEnd(), files };
}

/** Stands for `files[N]` in text handed to the Markdown renderer, which leaves it alone. */
export const FILE_MARKER = /\u0002(\d+)\u0002/g;

/**
 * Mark where the user put each file. The composer sends a chip as its file
 * name, so every occurrence of an attached file's name becomes
 * `\u0002<index>\u0002` (longest name first, so `a.tar.gz` wins over `a.tar`).
 * A file whose name is no longer in the text is marked at the end, so every
 * attached file still shows.
 */
export function markAttachedFiles(text: string, files: readonly AttachedFile[]): string {
	if (!files.length) return text;
	// A stray marker character typed by the user must not read as a file.
	const source = text.replace(/\u0002/g, "");
	const order = files
		.map((file, index) => ({ name: file.name, index }))
		.filter((entry) => entry.name)
		.sort((a, b) => b.name.length - a.name.length);
	const seen = new Set<number>();
	let out = "";
	let position = 0;
	while (position < source.length) {
		const hit = order.find((entry) => source.startsWith(entry.name, position));
		if (hit) {
			out += `\u0002${hit.index}\u0002`;
			seen.add(hit.index);
			position += hit.name.length;
		} else {
			out += source[position];
			position += 1;
		}
	}
	const missing = files.map((_file, index) => index).filter((index) => !seen.has(index));
	if (!missing.length) return out;
	const tail = missing.map((index) => `\u0002${index}\u0002`).join(" ");
	return out ? `${out} ${tail}` : tail;
}
