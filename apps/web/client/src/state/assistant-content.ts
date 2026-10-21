/** Only displayable structured content. Replay signatures never enter presentation rows. */
export type AssistantBlock =
	| { readonly type: "text"; readonly text: string; readonly index: number }
	| { readonly type: "thinking"; readonly thinking: string; readonly index: number }
	| {
			readonly type: "toolCall";
			readonly id: string;
			readonly name: string;
			readonly arguments: unknown;
			readonly index: number;
	  };

export function assistantBlocks(content: unknown): AssistantBlock[] {
	if (typeof content === "string") return content ? [{ type: "text", text: content, index: 0 }] : [];
	if (!Array.isArray(content)) return [];
	return content.flatMap((value: unknown, index): AssistantBlock[] => {
		if (!value || typeof value !== "object") return [];
		const part = value as Record<string, unknown>;
		if (part.type === "text" && typeof part.text === "string" && part.text) {
			return [{ type: "text", text: part.text, index }];
		}
		if (part.type === "thinking" && part.redacted !== true && typeof part.thinking === "string" && part.thinking) {
			return [{ type: "thinking", thinking: part.thinking, index }];
		}
		if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
			return [{ type: "toolCall", id: part.id, name: part.name, arguments: part.arguments, index }];
		}
		return [];
	});
}
