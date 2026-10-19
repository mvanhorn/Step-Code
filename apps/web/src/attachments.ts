/** A file the user attached to a message. `data` is base64. */
export interface WebAttachment {
	readonly name: string;
	readonly mimeType: string;
	readonly data: string;
	readonly kind: "image" | "text";
}

/** Files larger than this are refused rather than ballooning the prompt. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** How much of an oversized text attachment or uploaded file is inlined before truncating. */
export const MAX_INLINED_CHARS = 40_000;

export function classifyAttachment(mimeType: string): "image" | "text" {
	return mimeType.startsWith("image/") ? "image" : "text";
}

/**
 * Fold text attachments into the prompt.
 *
 * Images travel separately as real image content, so only text files need
 * inlining. The filename is repeated inside the block because the model
 * otherwise has no way to refer back to the file it was handed.
 */
export function withTextAttachments(text: string, attachments: readonly WebAttachment[]): string {
	const texts = attachments.filter((attachment) => attachment.kind === "text");
	if (!texts.length) return text;
	const blocks = texts.map((attachment) => {
		const decoded = Buffer.from(attachment.data, "base64").toString("utf8");
		const body =
			decoded.length > MAX_INLINED_CHARS ? `${decoded.slice(0, MAX_INLINED_CHARS)}\n… (truncated)` : decoded;
		return `[attached file: ${attachment.name}]\n\`\`\`\n${body}\n\`\`\``;
	});
	return [text, ...blocks].filter((part) => part.trim()).join("\n\n");
}
