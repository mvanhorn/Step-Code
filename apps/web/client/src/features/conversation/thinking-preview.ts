/**
 * The one-line preview behind a running thinking block.
 *
 * The preview used to be the last N characters of the streamed text, which
 * moves the whole window right on every token: the line looked like it was
 * being swept from left to right and nothing could be read. This keeps a
 * sentence-aligned window instead — the completed sentence plus the sentence
 * still being written — so the visible text only grows at its tail and shifts
 * once, when a sentence ends.
 */

/**
 * Longest window, in characters. A window that has grown past this drops its
 * oldest completed sentence even if the current one is unfinished, so a model
 * that never ends a sentence cannot push the preview off the edge.
 */
const MAX_PREVIEW_CHARS = 220;
/** A single sentence longer than this is cut at a word/clause boundary. */
const MAX_SENTENCE_CHARS = 140;

/**
 * Sentence terminators that end a readable unit in Chinese and English.
 *
 * The full-width marks are written as escapes on purpose: in a character class
 * they behave as combining marks, so a following literal joins their base and
 * the class silently stops matching the characters after them.
 */
const SENTENCE_END = /[\u3002\uFF01\uFF1F.!?\u2026\uFF1B;\n]/u;
/**
 * Clause breaks used to split an over-long sentence. The full-width punctuation
 * stays escaped for the same character-class reason as `SENTENCE_END`.
 */
const CLAUSE_END = /[\uFF0C,\u3001\uFF1A:\uFF09)\u300D\u300F"'\u201D\s]/u;

export interface ThinkingPreview {
	/** What to show; already collapsed to single spaces and trimmed. */
	readonly text: string;
	/**
	 * Stable identity of the visible sentences. Changes only when the window
	 * moves to a new sentence, so a client can restart its reveal animation then
	 * and leave it alone for every token of the same sentence.
	 */
	readonly key: number;
}

/**
 * Split `value` into sentences, keeping the terminator with the sentence it
 * ends. The last part is the sentence still being written (possibly empty).
 */
function sentences(value: string): string[] {
	const parts: string[] = [];
	let start = 0;
	for (let index = 0; index < value.length; index += 1) {
		if (!SENTENCE_END.test(value[index] ?? "")) continue;
		parts.push(value.slice(start, index + 1));
		start = index + 1;
	}
	if (start < value.length) parts.push(value.slice(start));
	return parts;
}

/** Cut an over-long sentence at the last clause break that fits, else hard-cut. */
function shorten(sentence: string): string {
	if (sentence.length <= MAX_SENTENCE_CHARS) return sentence;
	const head = sentence.slice(0, MAX_SENTENCE_CHARS);
	let cut = head.length;
	for (let index = head.length - 1; index >= 0; index -= 1) {
		if (CLAUSE_END.test(head[index] ?? "")) {
			cut = index + 1;
			break;
		}
	}
	return head.slice(0, cut);
}

function collapse(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

/**
 * The preview for the text streamed so far, or `undefined` before any text.
 *
 * A settled block has no preview: the disclosure header only carries one while
 * the block runs, and history keeps the whole text behind the chevron.
 */
export function thinkingPreview(content: string): ThinkingPreview | undefined {
	if (!content) return undefined;
	const parts = sentences(collapse(content));
	// Keep the running sentence plus the completed sentences that still fit.
	const visible: string[] = [];
	let used = 0;
	for (let index = parts.length - 1; index >= 0; index -= 1) {
		const part = shorten(parts[index] ?? "");
		const next = used + part.length;
		if (visible.length > 0 && next > MAX_PREVIEW_CHARS) break;
		visible.unshift(part);
		used = next;
	}
	const text = visible.join("").trim();
	if (!text) return undefined;
	// The key identifies the completed sentences in the window: it changes when a
	// sentence finishes, and stays put for every token of the sentence being written.
	const completed = visible.slice(0, -1);
	return { text, key: completed.length * 31 + (completed.at(-1)?.length ?? 0) };
}
