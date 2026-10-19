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
	prepend(messages: readonly { readonly text: string; readonly attachments: readonly WebAttachment[] }[]): void {
		if (!messages.length) return;
		const restored = messages.map((message) => ({ id: randomUUID(), ...message, files: [] }));
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

/** An image of a steering message, as the snapshot and the `queue` event carry it. */
export interface SteeringImage {
	readonly mimeType: string;
	readonly data: string;
}

/** A steering message the kernel has not delivered yet, with its images. */
export interface SteeringMessageView {
	readonly text: string;
	readonly images: readonly SteeringImage[];
}

/**
 * The images of steering messages. The kernel lists only the text of a steering
 * message it has not delivered (`getSteeringMessages`), so the host records the
 * images under that text: the conversation shows them while the message waits,
 * and a stop puts them back in the queue with the text.
 */
export class SteeringImages {
	private records: { readonly text: string; readonly images: readonly WebAttachment[] }[] = [];

	record(text: string, images: readonly WebAttachment[]): void {
		if (images.length) this.records = [...this.records, { text, images }];
	}

	/**
	 * Pair the kernel's pending texts with their images. The kernel delivers the
	 * oldest first, so the pending texts are the newest ones: pairing runs from
	 * the end. Records no text claims were delivered and are dropped.
	 */
	match(texts: readonly string[]): { readonly text: string; readonly images: readonly WebAttachment[] }[] {
		const left = [...this.records];
		const claimed = new Set<(typeof this.records)[number]>();
		const paired: { readonly text: string; readonly images: readonly WebAttachment[] }[] = [];
		for (let i = texts.length - 1; i >= 0; i -= 1) {
			const text = texts[i];
			let index = left.length - 1;
			while (index >= 0 && left[index].text !== text) index -= 1;
			const record = index < 0 ? undefined : left.splice(index, 1)[0];
			if (record) claimed.add(record);
			paired.unshift({ text, images: record?.images ?? [] });
		}
		this.records = this.records.filter((record) => claimed.has(record));
		return paired;
	}

	clear(): void {
		this.records = [];
	}
}
