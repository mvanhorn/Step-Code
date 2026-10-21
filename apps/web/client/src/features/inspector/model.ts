import type { SessionEntry, SubagentStatus, TimelineItem } from "../../state/types";

export interface SummaryAgentRecord {
	readonly key: string;
	readonly agent: string;
	readonly task: string;
	readonly status: SubagentStatus;
	readonly target:
		| { readonly kind: "task"; readonly toolItemId: string; readonly taskIndex: number }
		| { readonly kind: "child"; readonly sessionId: string }
		| { readonly kind: "workflow"; readonly runId: string };
}

/** Reuse validated timeline state; a returned dispatch does not prove child success. */
export function summaryAgentRecords(items: readonly TimelineItem[]): SummaryAgentRecord[] {
	const records: SummaryAgentRecord[] = [];
	for (const item of items) {
		if (item.kind !== "tool") continue;
		if (item.subagentTasks?.length) {
			for (const [index, task] of item.subagentTasks.entries()) {
				records.push({
					key: `${item.itemId}:task:${index}`,
					agent: task.agent,
					task: task.task,
					status: task.status,
					target: { kind: "task", toolItemId: item.itemId, taskIndex: index },
				});
			}
		} else if (item.children?.length) {
			for (const child of item.children) {
				records.push({
					key: `${item.itemId}:child:${child.sessionId}`,
					agent: child.label,
					task: item.inputSummary,
					status: "unknown",
					target: { kind: "child", sessionId: child.sessionId },
				});
			}
		} else if (item.workflowRun) {
			records.push({
				key: `${item.itemId}:workflow`,
				agent: "",
				task: item.inputSummary,
				status: "unknown",
				target: { kind: "workflow", runId: item.workflowRun },
			});
		} else if (item.toolName === "subagent" || item.toolName === "agent_send") {
			records.push({
				key: `${item.itemId}:dispatch`,
				agent: "",
				task: item.inputSummary,
				status: "unknown",
				target: { kind: "task", toolItemId: item.itemId, taskIndex: 0 },
			});
		}
	}
	return records;
}

export function finiteAmount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Only readable message blocks; opaque signatures and provider transport data stay out. */
export function recordedMessage(entry: SessionEntry): { role: string; content: unknown } | undefined {
	const message = entry.message;
	if (!message) return undefined;
	const content =
		typeof message.content === "string"
			? message.content
			: message.content?.map((part) => {
					if (part.type === "image") return { type: "image" };
					if (part.type === "thinking")
						return { type: "thinking", thinking: part.redacted ? undefined : part.thinking };
					if (part.type === "toolCall") return { type: part.type, name: part.name, arguments: part.arguments };
					return { type: part.type, text: part.text };
				});
	return { role: message.role, content };
}

export function messagePreview(entry: SessionEntry): string {
	const content = entry.message?.content;
	if (typeof content === "string") return content;
	return (
		content
			?.map((part) => part.text ?? part.name ?? "")
			.filter(Boolean)
			.join(" ") ?? ""
	);
}
