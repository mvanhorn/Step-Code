const EVENT_STATUS = {
	background_done: "completed",
	background_failed: "failed",
	background_interrupted: "aborted",
	background_progress: "running",
	background_restarted: "running",
	background_needs_input: "running",
} as const;

/** Project lifecycle fields only, not arbitrary custom-message payloads or notification text. */
export function projectSubagentNotification(customType: string, details: unknown): Record<string, string> | undefined {
	if (customType !== "agent-notification" || !details || typeof details !== "object" || Array.isArray(details)) return;
	const value = details as Record<string, unknown>;
	if (
		typeof value.agentId !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(value.agentId) ||
		typeof value.event !== "string" ||
		!Object.hasOwn(EVENT_STATUS, value.event)
	)
		return;
	const status = EVENT_STATUS[value.event as keyof typeof EVENT_STATUS];
	if (value.status !== status) return;
	return { agentId: value.agentId, event: value.event, status };
}
