import { randomUUID } from "node:crypto";
import type { WebAttachment } from "./attachments.ts";

/** A file chip the message named: the upload id plus the name shown in the queue. */
export interface QueuedFile {
	readonly id: string;
	readonly name: string;
}

/**
 * A message the user sent while a turn was running. It stays editable here
 * until it is dispatched; once handed to the kernel it can no longer change.
 * `text` is what the user typed: file chips are expanded only at dispatch, so
 * an edit never shows the inlined file content.
 */
export interface QueuedMessage {
	readonly id: string;
	readonly text: string;
	readonly attachments: readonly WebAttachment[];
	readonly files: readonly QueuedFile[];
}

/** What the snapshot and the `queue` event carry: no attachment bytes. */
export interface QueuedMessageView {
	readonly id: string;
	readonly text: string;
	readonly attachments: readonly { readonly name: string; readonly kind: WebAttachment["kind"] }[];
	readonly files: readonly QueuedFile[];
}

/**
 * The Web session's pending user messages, in send order. Every change calls
 * `onChange` so the session can publish the new list.
 */
export class MessageQueue {
	private items: QueuedMessage[] = [];
	private readonly onChange: () => void;

	constructor(onChange: () => void) {
		this.onChange = onChange;
	}

	get size(): number {
		return this.items.length;
	}

	add(input: Omit<QueuedMessage, "id">): QueuedMessage {
		const item: QueuedMessage = { ...input, id: randomUUID() };
		this.items = [...this.items, item];
		this.onChange();
		return item;
	}

	/** Put kernel messages taken back after an interrupt in front of the queue, oldest first. */
	prependTexts(texts: readonly string[]): void {
		if (!texts.length) return;
		const restored = texts.map((text) => ({ id: randomUUID(), text, attachments: [], files: [] }));
		this.items = [...restored, ...this.items];
		this.onChange();
	}

	/** Replace an item's text. False when the id is unknown (already dispatched or removed). */
	edit(id: string, text: string): boolean {
		const index = this.items.findIndex((item) => item.id === id);
		if (index < 0) return false;
		const next = [...this.items];
		next[index] = { ...next[index], text };
		this.items = next;
		this.onChange();
		return true;
	}

	/** Remove and return an item, or undefined when the id is unknown. */
	take(id: string): QueuedMessage | undefined {
		const item = this.items.find((candidate) => candidate.id === id);
		if (!item) return undefined;
		this.items = this.items.filter((candidate) => candidate !== item);
		this.onChange();
		return item;
	}

	/** Remove and return the oldest item. */
	shift(): QueuedMessage | undefined {
		const [first] = this.items;
		return first ? this.take(first.id) : undefined;
	}

	/** Remove and return every item, oldest first. */
	takeAll(): QueuedMessage[] {
		const items = this.items;
		if (!items.length) return [];
		this.items = [];
		this.onChange();
		return items;
	}

	/** Put items that could not be dispatched back in front, keeping their ids and order. */
	restore(items: readonly QueuedMessage[]): void {
		if (!items.length) return;
		this.items = [...items, ...this.items];
		this.onChange();
	}

	views(): QueuedMessageView[] {
		return this.items.map((item) => ({
			id: item.id,
			text: item.text,
			attachments: item.attachments.map((attachment) => ({ name: attachment.name, kind: attachment.kind })),
			files: item.files,
		}));
	}
}
