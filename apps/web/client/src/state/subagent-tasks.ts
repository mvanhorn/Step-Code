import type { SessionEntry, SubagentStatus, SubagentTask, ToolState } from "./types";

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function status(value: unknown): SubagentStatus {
	switch (value) {
		case "queued":
		case "running":
		case "completed":
		case "failed":
		case "aborted":
		case "skipped":
			return value;
		default:
			return "unknown";
	}
}

/** Only structured tool records define task state; prose and exit codes are not a lifecycle protocol. */
export function subagentTasks(
	input: unknown,
	details: unknown,
	toolState: ToolState,
	previous: readonly SubagentTask[] = [],
): readonly SubagentTask[] {
	const value = record(details);
	const backgroundAgentId = typeof value?.agentId === "string" ? value.agentId : undefined;
	const results = Array.isArray(value?.results) ? value.results : [];
	const tasks = results.flatMap((result): SubagentTask[] => {
		const item = record(result);
		if (!item || (typeof item.agent !== "string" && typeof item.task !== "string")) return [];
		const usage = record(item.usage);
		return [
			{
				agent: typeof item.agent === "string" ? item.agent : "",
				task: typeof item.task === "string" ? item.task : "",
				status: status(item.status),
				...(typeof item.sessionId === "string" && item.sessionId ? { sessionId: item.sessionId } : {}),
				...(backgroundAgentId ? { backgroundAgentId } : {}),
				...(typeof item.model === "string" ? { model: item.model } : {}),
				...(typeof usage?.turns === "number" && Number.isSafeInteger(usage.turns) && usage.turns >= 0
					? { turns: usage.turns }
					: {}),
				...(typeof item.errorMessage === "string" && item.errorMessage ? { error: item.errorMessage } : {}),
			},
		];
	});
	if (tasks.length) return tasks;
	// A rejected dispatch must remain an ordinary failed tool, including its original error.
	if (toolState === "failed") return [];
	if (previous.length)
		return previous.map((task) => ({
			...task,
			status:
				toolState === "completed" && (task.status === "queued" || task.status === "running")
					? "unknown"
					: task.status,
		}));
	const args = record(input);
	const planned = Array.isArray(args?.tasks)
		? args.tasks
		: Array.isArray(args?.chain)
			? args.chain
			: args
				? [args]
				: [];
	return planned.flatMap((candidate): SubagentTask[] => {
		const task = record(candidate);
		if (!task || (typeof task.agent !== "string" && typeof task.task !== "string")) return [];
		return [
			{
				agent: typeof task.agent === "string" ? task.agent : "",
				task: typeof task.task === "string" ? task.task : "",
				// Planned arguments do not prove execution started.
				status: toolState === "pending" ? "queued" : "unknown",
			},
		];
	});
}

const NOTIFICATION_STATUS: Readonly<Record<string, SubagentStatus>> = {
	background_done: "completed",
	background_failed: "failed",
	background_interrupted: "aborted",
	background_progress: "running",
	background_restarted: "running",
	background_needs_input: "running",
};

/** Background dispatch results are snapshots; subsequent structured notifications own lane state. */
export function backgroundSubagentStatuses(entries: readonly SessionEntry[]): ReadonlyMap<string, SubagentStatus> {
	const states = new Map<string, SubagentStatus>();
	for (const entry of entries) {
		const message = entry.message;
		const details = record(message?.details);
		if (message?.role === "toolResult" && message.toolName === "subagent" && typeof details?.agentId === "string") {
			const initial = status(details.status);
			if (initial !== "unknown") states.set(details.agentId, initial);
		}
	}
	for (const entry of entries) {
		const message = entry.message;
		const details = record(entry.type === "custom_message" ? entry.details : message?.details);
		if (typeof details?.agentId !== "string" || !states.has(details.agentId)) continue;
		if (
			((entry.type === "custom_message" && entry.customType === "agent-notification") ||
				(message?.role === "custom" && message.customType === "agent-notification")) &&
			typeof details.event === "string" &&
			Object.hasOwn(NOTIFICATION_STATUS, details.event) &&
			details.status === NOTIFICATION_STATUS[details.event]
		) {
			states.set(details.agentId, NOTIFICATION_STATUS[details.event]);
		} else if (
			message?.role === "toolResult" &&
			message.toolName === "agent_send" &&
			status(details.status) !== "unknown"
		) {
			states.set(details.agentId, status(details.status));
		}
	}
	return states;
}
