import type { SessionEntry } from "@step-harness/coding-agent";

export interface InspectorTask {
	readonly id: string;
	readonly subject: string;
	readonly description: string;
	readonly status: "pending" | "in_progress" | "completed";
}

/** Whitelist presentation fields from the latest canonical active-branch task snapshot. */
export function projectInspectorTasks(entries: readonly SessionEntry[]): {
	plan?: { id: string; title: string };
	tasks: InspectorTask[];
} {
	const entry = [...entries]
		.reverse()
		.find((candidate) => candidate.type === "custom" && candidate.customType === "step-tasks");
	if (!entry || entry.type !== "custom" || !entry.data || typeof entry.data !== "object") return { tasks: [] };
	const data = entry.data as Record<string, unknown>;
	const tasks: InspectorTask[] = [];
	const seen = new Set<string>();
	for (const raw of Array.isArray(data.tasks) ? data.tasks : []) {
		if (!raw || typeof raw !== "object") continue;
		const task = raw as Record<string, unknown>;
		if (typeof task.id !== "string" || seen.has(task.id) || typeof task.subject !== "string") continue;
		if (task.status !== "pending" && task.status !== "in_progress" && task.status !== "completed") continue;
		seen.add(task.id);
		tasks.push({
			id: task.id,
			subject: task.subject,
			description: typeof task.description === "string" ? task.description : "",
			status: task.status,
		});
	}
	const plan = data.activePlan;
	if (
		plan &&
		typeof plan === "object" &&
		"id" in plan &&
		"title" in plan &&
		typeof plan.id === "string" &&
		typeof plan.title === "string"
	) {
		return { tasks, plan: { id: plan.id, title: plan.title } };
	}
	return { tasks };
}
