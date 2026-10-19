/**
 * DOM helpers for the composer's contenteditable `#prompt`.
 *
 * The prompt is plain text plus inline file chips: a chip is a non-editable
 * `<span class="prompt-file">` naming a file the host stored (see
 * `uploadFile`). The user writes around chips ("参考 [latest.json] 实现"), so a
 * sent message is the text in document order with each chip replaced by the
 * path of its stored copy. Only text and chips are ever inserted: pastes and
 * drops are intercepted, and the serialiser below reads any other markup a
 * browser produces (line-break `<br>`, block `<div>`) as text.
 */

import type { UploadedFile } from "../../state/types";

const CHIP_CLASS = "prompt-file";
const SVG_NS = "http://www.w3.org/2000/svg";

/** Uploads still running, by chip key: send waits for them so no chip is sent without its path. */
const pendingUploads = new Map<string, Promise<void>>();
let nextChipKey = 0;

function chipText(chip: HTMLElement): string {
	const path = chip.dataset.path;
	return path ? `\`${path}\`` : (chip.dataset.name ?? "");
}

function serialize(parent: Node): string {
	let out = "";
	for (const child of parent.childNodes) {
		if (child instanceof Text) {
			out += child.data.replace(/\u00a0/g, " ");
		} else if (child instanceof HTMLElement) {
			if (child.classList.contains(CHIP_CLASS)) out += chipText(child);
			else if (child.tagName === "BR") out += "\n";
			else if (child.tagName === "DIV" || child.tagName === "P") {
				// A block starts a new line unless one just ended.
				if (out && !out.endsWith("\n")) out += "\n";
				out += serialize(child);
			} else out += serialize(child);
		}
	}
	return out;
}

/** The prompt as message text: chips become their stored paths. */
export function promptText(root: HTMLElement): string {
	return serialize(root);
}

/**
 * Deleting everything can leave a stray `<br>` behind; remove it so `:empty`
 * shows the placeholder again. Never call this during an IME composition.
 */
export function tidyEmptyPrompt(root: HTMLElement): void {
	if (root.firstChild && !root.textContent && !root.querySelector(`.${CHIP_CLASS}`)) root.replaceChildren();
}

function select(range: Range): void {
	const selection = getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
}

export function placeCaretAtEnd(root: HTMLElement): void {
	const range = document.createRange();
	range.selectNodeContents(root);
	range.collapse(false);
	select(range);
}

/** Replace the whole prompt with `text` and put the caret after it. */
export function setPromptText(root: HTMLElement, text: string): void {
	root.replaceChildren(...(text ? [document.createTextNode(text)] : []));
	if (document.activeElement === root) placeCaretAtEnd(root);
}

/** The selection inside `root`, or a collapsed range at its end when the selection is elsewhere. */
function caretRange(root: HTMLElement): Range {
	const selection = getSelection();
	if (selection?.rangeCount) {
		const range = selection.getRangeAt(0);
		if (root.contains(range.commonAncestorContainer)) return range;
	}
	const range = document.createRange();
	range.selectNodeContents(root);
	range.collapse(false);
	return range;
}

/**
 * Insert plain text at the caret. `execCommand` keeps the browser's undo
 * history and fires `input`; the range fallback covers a browser that refuses.
 */
export function insertTextAtCaret(root: HTMLElement, text: string): void {
	if (!text) return;
	select(caretRange(root));
	if (document.execCommand("insertText", false, text)) return;
	const range = caretRange(root);
	range.deleteContents();
	const node = document.createTextNode(text);
	range.insertNode(node);
	range.setStartAfter(node);
	range.collapse(true);
	select(range);
	root.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Shift+Enter: a `<br>` line break rather than the browser's default block split. */
export function insertLineBreak(root: HTMLElement): void {
	select(caretRange(root));
	if (!document.execCommand("insertLineBreak")) insertTextAtCaret(root, "\n");
}

/** Move the caret to the drop point, when that point is inside the prompt. */
export function placeCaretAtPoint(root: HTMLElement, x: number, y: number): void {
	let range: Range | null = null;
	// caretPositionFromPoint is Chrome 128+ / Safari 18+; older WebKit has only caretRangeFromPoint.
	const position =
		typeof document.caretPositionFromPoint === "function" ? document.caretPositionFromPoint(x, y) : null;
	if (position) {
		range = document.createRange();
		range.setStart(position.offsetNode, position.offset);
	} else if (typeof document.caretRangeFromPoint === "function") {
		range = document.caretRangeFromPoint(x, y);
	}
	if (!range || !root.contains(range.startContainer)) return;
	range.collapse(true);
	select(range);
}

function createChip(name: string, key: string): HTMLSpanElement {
	const chip = document.createElement("span");
	chip.className = CHIP_CLASS;
	chip.contentEditable = "false";
	chip.dataset.uploadKey = key;
	chip.dataset.name = name;
	chip.dataset.state = "uploading";
	chip.title = name;
	const icon = document.createElementNS(SVG_NS, "svg");
	icon.setAttribute("class", "icon icon--xs");
	icon.setAttribute("aria-hidden", "true");
	const use = document.createElementNS(SVG_NS, "use");
	use.setAttribute("href", "#i-fileText");
	icon.append(use);
	const label = document.createElement("span");
	label.textContent = name;
	chip.append(icon, label);
	return chip;
}

/**
 * Insert a chip for `name` at the caret, followed by a space so the caret can
 * sit after it. The chip gets its path when `upload` settles; a failed upload
 * removes the chip and reports through `onFail`.
 */
export function insertFileChip(
	root: HTMLElement,
	name: string,
	upload: Promise<UploadedFile>,
	onFail: (error: unknown) => void,
): void {
	nextChipKey += 1;
	const key = String(nextChipKey);
	const chip = createChip(name, key);
	const range = caretRange(root);
	range.deleteContents();
	const space = document.createTextNode(" ");
	// insertNode puts each node at the range start: the space first, then the chip before it.
	range.insertNode(space);
	range.insertNode(chip);
	range.setStartAfter(space);
	range.collapse(true);
	select(range);
	const settled = upload
		.then(
			(file) => {
				chip.dataset.path = file.path;
				chip.dataset.state = "ready";
				chip.title = file.path;
			},
			(error: unknown) => {
				chip.remove();
				onFail(error);
			},
		)
		.finally(() => pendingUploads.delete(key));
	pendingUploads.set(key, settled);
}

/** Resolve once every chip inserted so far has its path or has been removed. */
export async function waitForUploads(): Promise<void> {
	await Promise.all(pendingUploads.values());
}

/** A copy of the prompt's content, put back by `restorePrompt` when a send fails. */
export function snapshotPrompt(root: HTMLElement): Node[] {
	return [...root.childNodes].map((node) => node.cloneNode(true));
}

export function restorePrompt(root: HTMLElement, nodes: readonly Node[]): void {
	root.replaceChildren(...nodes);
	placeCaretAtEnd(root);
}
