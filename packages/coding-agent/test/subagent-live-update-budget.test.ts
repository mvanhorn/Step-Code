import type { AgentToolResult } from "@step-harness/agent-core";
import { expect, test } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import {
	createStepSubagentExtension,
	type StepSubagentDetails,
	type StepSubagentRunInput,
	type StepSubagentRunResult,
} from "../src/features/step-subagent.ts";

/**
 * Regression guard for the event-log amplification: every child event used to
 * become one `tool_execution_update` carrying the child's whole `messages` array,
 * so a 40-turn child wrote ~5 GB of JSONL whose lines were byte-identical
 * repeats. These tests pin both halves of the bound — payload size and rate —
 * and that neither costs a status transition or the final transcript.
 */

const LIVE_UPDATE_MAX_BYTES = 32 * 1024;

function message(index: number, bytes: number): StepSubagentRunResult["messages"][number] {
	return {
		role: index % 2 === 0 ? "assistant" : "toolResult",
		content: [{ type: "text", text: "x".repeat(bytes) }],
		...(index % 2 === 0
			? {
					api: "anthropic-messages",
					provider: "step",
					model: "step-3.8-code-alpha",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop" as const,
					timestamp: 1,
				}
			: { toolCallId: `call_${index}`, toolName: "run_command", isError: false, timestamp: 1 }),
	} as StepSubagentRunResult["messages"][number];
}

function createApi(): { api: ExtensionAPI; tools: Map<string, ToolDefinition> } {
	const tools = new Map<string, ToolDefinition>();
	const api = {
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		registerFlag: () => {},
		registerShortcut: () => {},
		on: () => {},
		getActiveTools: () => [],
		setActiveTools: () => {},
		getFlag: () => false,
		appendEntry: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
	} as unknown as ExtensionAPI;
	return { api, tools };
}

function createContext(cwd: string): ExtensionContext {
	return {
		mode: "json",
		hasUI: false,
		cwd,
		model: undefined,
		thinkingLevel: "high",
		isIdle: () => true,
		isProjectTrusted: () => true,
		ui: { confirm: async () => true, setWidget: () => {}, notify: () => {} },
		sessionManager: { getEntries: () => [] },
	} as unknown as ExtensionContext;
}

interface Captured {
	details?: StepSubagentDetails;
	bytes: number;
	at: number;
}

async function runOnce(
	runner: (input: StepSubagentRunInput) => Promise<StepSubagentRunResult>,
): Promise<{ updates: Captured[]; result: AgentToolResult<StepSubagentDetails> }> {
	const { api, tools } = createApi();
	createStepSubagentExtension({ agentDir: "/tmp/step-agent-test", runner })(api);
	const updates: Captured[] = [];
	const startedAt = Date.now();
	const result = (await tools.get("subagent")!.execute(
		"call",
		{ agent: "general", task: "inspect" } as never,
		undefined,
		(update) => {
			const details = update.details as StepSubagentDetails | undefined;
			updates.push({
				details,
				bytes: Buffer.byteLength(JSON.stringify(update), "utf8"),
				at: Date.now() - startedAt,
			});
		},
		createContext("/workspace"),
	)) as AgentToolResult<StepSubagentDetails>;
	return { updates, result };
}

test("a long streaming child produces bounded live updates instead of the whole transcript", async () => {
	const messages: StepSubagentRunResult["messages"] = [message(0, 2_000)];
	const { updates, result } = await runOnce(async (input) => {
		for (let index = 0; index < 400; index += 1) {
			messages.push(message(messages.length, 20_000));
			input.onUpdate?.({
				messages,
				stderr: "",
				exitCode: -1,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
				activeText: "y".repeat(50_000),
				activeTool: "run_command",
				activeToolArgs: "z".repeat(20_000),
				activeToolOutput: "w".repeat(20_000),
				lastEvent: "message_update",
			});
			// Let the coalescing timer fire so a live UI still gets updates.
			if (index % 40 === 0) await new Promise((resolve) => setTimeout(resolve, 5));
		}
		return { messages, stderr: "", exitCode: 0, usage: {} as never, stopReason: "stop" };
	});

	expect(updates.length).toBeGreaterThan(1);
	// 400 events carrying a growing multi-megabyte transcript must not survive
	// into the payload: no update carries `messages`, and each stays small.
	for (const update of updates) {
		const records = update.details?.results ?? [];
		expect(records).toHaveLength(1);
		expect(records[0]?.messages).toEqual([]);
		expect(update.bytes).toBeLessThan(LIVE_UPDATE_MAX_BYTES);
	}
	const totalBytes = updates.reduce((sum, update) => sum + update.bytes, 0);
	expect(totalBytes).toBeLessThan(2 * 1024 * 1024);
	// The final result still describes the child and its transcript reference.
	expect(result.details?.results[0]?.status).toBe("completed");
});

test("the final result keeps the newest transcript messages within the byte budget", async () => {
	const messages: StepSubagentRunResult["messages"] = [];
	for (let index = 0; index < 20; index += 1) messages.push(message(index, 40_000));
	const { result } = await runOnce(async () => ({
		messages,
		stderr: "",
		exitCode: 0,
		usage: {} as never,
		stopReason: "stop",
	}));
	const kept = result.details?.results[0]?.messages ?? [];
	expect(kept.length).toBeGreaterThan(0);
	expect(kept.length).toBeLessThan(messages.length);
	// The newest message survives; older ones are dropped, not the other way round.
	expect(kept.at(-1)).toEqual(messages.at(-1));
	expect(Buffer.byteLength(JSON.stringify(kept), "utf8")).toBeLessThanOrEqual(64 * 1024);
});

test("a status transition publishes immediately, inside the coalescing window", async () => {
	const { updates } = await runOnce(async (input) => {
		// Two events within one interval: the running transition must not wait.
		input.onUpdate?.({ messages: [], stderr: "", exitCode: -1, usage: {} as never, lastEvent: "turn_start" });
		input.onUpdate?.({ messages: [], stderr: "", exitCode: -1, usage: {} as never, lastEvent: "turn_start" });
		await new Promise((resolve) => setTimeout(resolve, 150));
		return { messages: [], stderr: "", exitCode: 0, usage: {} as never, stopReason: "stop" };
	});
	const statuses = updates.map((update) => update.details?.results[0]?.status);
	expect(statuses[0]).toBe("queued");
	expect(statuses).toContain("running");
	expect(statuses.at(-1)).toBe("completed");
	// `running` arrived before the child finished, not only in the trailing flush.
	const runningIndex = statuses.indexOf("running");
	expect(runningIndex).toBeLessThan(statuses.length - 1);
});
