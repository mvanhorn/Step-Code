/**
 * Minimal Markdown renderer and text helpers (legacy app.js `escapeHtml`,
 * `contentText`, `renderMarkdown`).
 *
 * The renderer is deliberately tiny: fenced code blocks, `#`/`##`/`###`
 * headings, `-` / `*` bullets, GFM pipe tables, links, `**bold**`, inline code,
 * line breaks and paragraph gaps. Everything else is
 * escaped. Its output is an HTML string meant for `dangerouslySetInnerHTML`
 * (see ui/MarkdownView, which also wires the `.copy-code` buttons).
 */

const HTML_ESCAPES: Readonly<Record<string, string>> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

export function escapeHtml(value: unknown): string {
	return String(value).replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/** Text of a message `content` value: a string, or the text parts of a content array. */
export function contentText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.filter((part): part is { type: "text"; text: string } => part?.type === "text")
		.map((part) => part.text)
		.join("");
}

export interface MarkdownLabels {
	/** Header label of a fenced block without a language (legacy `t("code")`). */
	readonly code: string;
	/** Text of the copy button in each code block header (legacy `t("copy")`). */
	readonly copy: string;
}

/** Only explicit web and email destinations may become clickable model output. */
function renderLink(label: string, destination: string): string {
	try {
		const url = new URL(destination);
		if (["http:", "https:", "mailto:"].includes(url.protocol)) {
			return `<a href="${escapeHtml(destination)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
		}
	} catch {
		// Incomplete streaming links and invalid URLs remain readable text.
	}
	return escapeHtml(label);
}

/** GFM delimiter row, e.g. `|---|:---:|`: dashes with optional alignment colons, separated by pipes. */
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/** Cells of one table row; a `\|` stays a literal pipe. Inline code is already a placeholder here. */
function tableCells(line: string): string[] {
	const trimmed = line
		.trim()
		.replace(/^\|/, "")
		.replace(/(?<!\\)\|$/, "");
	return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function tableAlignment(cell: string): string {
	const left = cell.startsWith(":");
	const right = cell.endsWith(":");
	if (left && right) return ' style="text-align:center"';
	if (right) return ' style="text-align:right"';
	return left ? ' style="text-align:left"' : "";
}

/**
 * Replace GFM pipe tables with block placeholders. A table is a header row
 * with a pipe, a delimiter row with the same column count, then every
 * following line that still contains a pipe. `renderCell` formats one cell's
 * source (escaping and inline Markdown).
 */
function extractTables(source: string, blocks: string[], renderCell: (cell: string) => string): string {
	const lines = source.split("\n");
	const output: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		const header = lines[index];
		const delimiter = lines[index + 1];
		if (!header.includes("|") || delimiter === undefined || !TABLE_DELIMITER.test(delimiter)) {
			output.push(header);
			continue;
		}
		const columns = tableCells(header);
		const alignments = tableCells(delimiter).map(tableAlignment);
		if (alignments.length !== columns.length) {
			output.push(header);
			continue;
		}
		const rows: string[][] = [];
		index += 2;
		while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
			rows.push(tableCells(lines[index]));
			index++;
		}
		index--;
		const row = (cells: readonly string[], tag: "th" | "td") =>
			`<tr>${columns.map((_, column) => `<${tag}${alignments[column]}>${renderCell(cells[column] ?? "")}</${tag}>`).join("")}</tr>`;
		const body = rows.length ? `<tbody>${rows.map((cells) => row(cells, "td")).join("")}</tbody>` : "";
		const table = `<div class="md-table-wrap"><table class="md-table"><thead>${row(columns, "th")}</thead>${body}</table></div>`;
		output.push(`\u0000${blocks.push(table) - 1}\u0000`);
	}
	return output.join("\n");
}

export function renderMarkdown(value: unknown, labels: MarkdownLabels): string {
	const blocks: string[] = [];
	const inlines: string[] = [];
	const source = String(value)
		.replace(/[\u0000\u0001]/g, "")
		.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_match, language: string, code: string) => {
			const label = language.trim() || labels.code;
			const index =
				blocks.push(
					`<div class="code-block"><div class="code-block-header"><span>${escapeHtml(label)}</span><button class="copy-code" type="button">${labels.copy}</button></div><pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre></div>`,
				) - 1;
			return `\u0000${index}\u0000`;
		});
	// Protect inline code and links before formatting so URL punctuation and HTML
	// attributes cannot be interpreted as Markdown. Fenced code is already protected.
	const inlineSource = source.replace(
		/`([^`]+)`|\[([^\]\n]+)\]\(\s*(<?(?:[^\s()<>]|\([^\s()]*\))+>?)\s*\)|https?:\/\/[^\s<>\u0000\u0001]+/g,
		(match, code: string | undefined, label: string | undefined, destination: string | undefined) => {
			let html: string;
			let suffix = "";
			if (code !== undefined) {
				html = `<code>${escapeHtml(code)}</code>`;
			} else if (label !== undefined && destination !== undefined) {
				html = renderLink(label, destination.replace(/^<(.*)>$/, "$1"));
			} else {
				let url = match.replace(/[.,!?;:，。！？；：、]+$/, "");
				while (url.endsWith(")") && url.split(")").length > url.split("(").length) url = url.slice(0, -1);
				suffix = match.slice(url.length);
				html = renderLink(url, url);
			}
			return `\u0001${inlines.push(html) - 1}\u0001${suffix}`;
		},
	);
	// Table cells are formatted here because their HTML becomes a block, which
	// the line-based formatting below never sees.
	const tableSource = extractTables(inlineSource, blocks, (cell) =>
		escapeHtml(cell)
			.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
			.replace(/\u0001(\d+)\u0001/g, (_match, index: string) => inlines[Number(index)] ?? ""),
	);
	const html = escapeHtml(tableSource.replace(/\n{3,}/g, "\n\n"))
		.replace(/^### (.+)$/gm, "<h4>$1</h4>")
		.replace(/^## (.+)$/gm, "<h3>$1</h3>")
		.replace(/^# (.+)$/gm, "<h2>$1</h2>")
		.replace(/^[-*] (.+)$/gm, '<span class="md-li">$1</span>')
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		// Headings and code blocks are blocks: the line breaks around them would only add empty lines.
		.replace(/\n*(<h[234]>.*?<\/h[234]>|\u0000\d+\u0000)\n*/g, "$1")
		// List items are blocks too; only the line break after each one goes.
		.replace(/(<span class="md-li">.*?<\/span>)\n(?!\n)/g, "$1")
		// A blank line separates paragraphs with a small gap rather than a whole empty line.
		.replace(/\n\n/g, '<span class="md-gap"></span>')
		.replace(/\n/g, "<br>");
	return html
		.replace(/\u0001(\d+)\u0001/g, (_match, index: string) => inlines[Number(index)] ?? "")
		.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => blocks[Number(index)] ?? "");
}

/** A user message that invoked a skill: the skill's name and what the user asked with it. */
export interface SkillInvocation {
	readonly name: string;
	readonly request: string;
}

/**
 * The kernel replaces `/skill:<name> request` with the skill's instructions in
 * a `<skill name location>` block followed by the request (coding-agent
 * `parseSkillBlock`); a message not yet sent still has the slash form.
 */
export function skillInvocation(text: string): SkillInvocation | null {
	const block = /^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/.exec(text);
	if (block) return { name: block[1], request: block[2]?.trim() ?? "" };
	const command = /^\/skill:(\S+)(?:\s+([\s\S]*))?$/.exec(text);
	return command ? { name: command[1], request: command[2]?.trim() ?? "" } : null;
}
