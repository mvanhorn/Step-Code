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
 * repeats. These tests pin the bound on every field a runner controls, the
 * coalescing rate, and the emitter's lifecycle; `subagent-live-update-rpc.test.ts`
 * covers the same path through a real rpc child.
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
	/** Rendered text of the partial result, as a UI would read it. */
	text: string;
}

async function run(
	params: Record<string, unknown>,
	runner: (input: StepSubagentRunInput) => Promise<StepSubagentRunResult>,
	options: { onUpdateError?: Error; sink?: Captured[] } = {},
): Promise<{ updates: Captured[]; result: AgentToolResult<StepSubagentDetails> }> {
	const { api, tools } = createApi();
	createStepSubagentExtension({ agentDir: "/tmp/step-agent-test", runner })(api);
	const updates: Captured[] = options.sink ?? [];
	const startedAt = Date.now();
	const result = (await tools.get("subagent")!.execute(
		"call",
		params as never,
		undefined,
		(update) => {
			const details = update.details as StepSubagentDetails | undefined;
			const text = update.content.find((block) => block.type === "text");
			updates.push({
				details,
				bytes: Buffer.byteLength(JSON.stringify(update), "utf8"),
				at: Date.now() - startedAt,
				text: text?.type === "text" ? text.text : "",
			});
			if (options.onUpdateError) throw options.onUpdateError;
		},
		createContext("/workspace"),
	)) as AgentToolResult<StepSubagentDetails>;
	return { updates, result };
}

const idle: StepSubagentRunResult = {
	messages: [],
	stderr: "",
	exitCode: -1,
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 },
};

test("a long streaming child produces bounded live updates instead of the whole transcript", async () => {
	const messages: StepSubagentRunResult["messages"] = [message(0, 2_000)];
	const { updates, result } = await run({ agent: "general", task: "inspect" }, async (input) => {
		for (let index = 0; index < 400; index += 1) {
			messages.push(message(messages.length, 20_000));
			input.onUpdate?.({
				...idle,
				messages,
				activeText: "y".repeat(50_000),
				activeTool: "run_command",
				activeToolArgs: "z".repeat(20_000),
				activeToolOutput: "w".repeat(20_000),
				lastEvent: "message_update",
			});
			if (index % 40 === 0) await new Promise((resolve) => setTimeout(resolve, 5));
		}
		return { ...idle, messages, exitCode: 0, stopReason: "stop" };
	});

	expect(updates.length).toBeGreaterThan(1);
	for (const update of updates) {
		const records = update.details?.results ?? [];
		expect(records).toHaveLength(1);
		expect(records[0]?.messages).toEqual([]);
		expect(update.bytes).toBeLessThan(LIVE_UPDATE_MAX_BYTES);
	}
	expect(updates.reduce((sum, update) => sum + update.bytes, 0)).toBeLessThan(2 * 1024 * 1024);
	expect(result.details?.results[0]?.status).toBe("completed");
});

test("a chain's spliced {previous} prompt stays out of every live update", async () => {
	const { updates } = await run(
		{
			chain: [
				{ agent: "general", task: "first" },
				{ agent: "general", task: "then {previous}" },
			],
		},
		async (input) => {
			// The first step returns a huge answer; the second step's task therefore
			// carries it verbatim, and every update during that step would repeat it.
			const isSecond = input.task.includes("then ");
			input.onUpdate?.({ ...idle, activeText: "working" });
			return {
				...idle,
				messages: [message(0, isSecond ? 100 : 500_000)],
				exitCode: 0,
				stopReason: "stop",
			};
		},
	);

	for (const update of updates) {
		expect(update.bytes).toBeLessThan(LIVE_UPDATE_MAX_BYTES);
		for (const record of update.details?.results ?? []) {
			expect(record.task.length).toBeLessThanOrEqual(600);
		}
	}
	// The second step really did receive the spliced prompt, so the bound above
	// is not vacuous.
	expect(updates.some((update) => update.details?.results.length === 2)).toBe(true);
});

test("streamed deltas and status changes coalesce into one publish per interval", async () => {
	const seen: Captured[] = [];
	const { updates } = await run(
		{ agent: "general", task: "inspect" },
		async (input) => {
			for (let index = 0; index < 200; index += 1) input.onUpdate?.({ ...idle, activeText: `a${index}` });
			// Stay running past one interval so a coalesced publish is observable.
			await new Promise((resolve) => setTimeout(resolve, 150));
			return { ...idle, exitCode: 0, stopReason: "stop" };
		},
		{ sink: seen },
	);

	// 200 deltas must not produce 200 publishes: queued, running, at most a
	// couple of interval publishes, then completed.
	expect(updates.length).toBeLessThanOrEqual(6);
	expect(updates.length).toBeGreaterThanOrEqual(3);
	// A short-lived status may never reach the wire; the terminal state always does.
	expect(updates.at(-1)?.details?.results[0]?.status).toBe("completed");
});

test("a large parallel batch publishes at the tick rate, not once per status change", async () => {
	const tasks = 200;
	const seen: Captured[] = [];
	const startedAt = Date.now();
	const { updates } = await run(
		{
			tasks: Array.from({ length: tasks }, (_, index) => ({ agent: "general", task: `task ${index}` })),
		},
		async (input) => {
			input.onUpdate?.({ ...idle, activeText: "working" });
			// Stay running across several ticks so the roster is republished, which
			// is what used to make this quadratic.
			await new Promise<void>((resolve) => setTimeout(resolve, 120));
			return { ...idle, exitCode: 0, stopReason: "stop" };
		},
		{ sink: seen },
	);
	const elapsedMs = Date.now() - startedAt;

	// The invariant is a rate, not a count: a slow runner legitimately spends more
	// ticks on the same batch. Before the change, each of the 2 x 200 status
	// transitions republished the whole roster, so the count tracked the batch.
	expect(updates.length).toBeLessThanOrEqual(Math.ceil(elapsedMs / 100) + 10);
	const largest = Math.max(...updates.map((update) => update.bytes));
	expect(largest).toBeLessThan(128 * 1024);
	// A bounded roster says what it left out instead of dropping it silently.
	expect(updates.some((update) => (update.details?.omittedResults ?? 0) > 0)).toBe(true);
});

test("an instantly finished parallel batch does not publish once per task", async () => {
	// The strongest form of the same guard, independent of wall clock: with 200
	// tasks that settle immediately, per-status publishing produced ~400 updates
	// of the whole roster. Coalescing makes it a handful.
	const tasks = 200;
	const { updates } = await run(
		{
			tasks: Array.from({ length: tasks }, (_, index) => ({ agent: "general", task: `task ${index}` })),
		},
		async (input) => {
			input.onUpdate?.({ ...idle, activeText: "working" });
			return { ...idle, exitCode: 0, stopReason: "stop" };
		},
	);

	expect(updates.length).toBeLessThanOrEqual(10);
	expect(updates.at(-1)?.details?.results.every((record) => record.status === "completed")).toBe(true);
});

test("the final result keeps the newest transcript messages and says it truncated", async () => {
	const messages: StepSubagentRunResult["messages"] = [];
	for (let index = 0; index < 20; index += 1) messages.push(message(index, 40_000));
	const { result } = await run({ agent: "general", task: "inspect" }, async () => ({
		...idle,
		messages,
		exitCode: 0,
		stopReason: "stop",
	}));
	const record = result.details?.results[0];
	const kept = record?.messages ?? [];
	expect(kept.length).toBeGreaterThan(0);
	expect(kept.length).toBeLessThan(messages.length);
	expect(kept.at(-1)).toEqual(messages.at(-1));
	// Serialized array, brackets and commas included, stays inside the budget.
	expect(Buffer.byteLength(JSON.stringify(kept), "utf8")).toBeLessThanOrEqual(64 * 1024);
	expect(record?.messagesTruncated).toBe(true);
});

test("a single message larger than the budget still leaves a readable result", async () => {
	const { result } = await run({ agent: "general", task: "inspect" }, async () => ({
		...idle,
		// No `activeText` at all: a custom runner that only reports messages.
		messages: [message(0, 200_000)],
		exitCode: 0,
		stopReason: "stop",
	}));
	const record = result.details?.results[0];
	expect(record?.messages).toEqual([]);
	expect(record?.messagesTruncated).toBe(true);
	// The fallback keeps the outcome renderable instead of "(no output)".
	expect(record?.activeText ?? "").toContain("x");
});

test("many large answers stay inside one per-call details budget", async () => {
	// This is the exhaustion path: the first records consume the shared budget,
	// so later ones get a tiny allowance. A zero-or-one-character allowance used
	// to return the whole value, turning the bound back into "unbounded".
	const tasks = 60;
	const { result } = await run(
		{ tasks: Array.from({ length: tasks }, (_, index) => ({ agent: "general", task: `t${index}` })) },
		async () => ({ ...idle, activeText: "q".repeat(300_000), exitCode: 0, stopReason: "stop" }),
	);
	const details = result.details;
	expect(details?.results).toHaveLength(tasks);
	// 256 KiB covers the heavy fields (text + transcript). Small per-record
	// metadata (agent, status, usage, ids) is separately bounded per record, so
	// the total is O(tasks) with a small constant, never O(output size).
	const totalBytes = Buffer.byteLength(JSON.stringify(details), "utf8");
	expect(totalBytes).toBeLessThanOrEqual(256 * 1024 + tasks * 1024);
	for (const record of details?.results ?? []) {
		expect((record.activeText ?? "").length).toBeLessThanOrEqual(50_000);
	}
});

test("a huge final answer is bounded in the display projection", async () => {
	const { result } = await run({ agent: "general", task: "inspect" }, async () => ({
		...idle,
		activeText: "q".repeat(400_000),
		exitCode: 0,
		stopReason: "stop",
	}));
	const record = result.details?.results[0];
	// Matches the renderer's own truncation, so an expanded view is not reduced.
	expect((record?.activeText ?? "").length).toBeLessThanOrEqual(50_000);
	// The model-facing text is not the details field.
	expect(result.content[0]).toMatchObject({ type: "text" });
});

test("a late child callback after the call returns emits nothing", async () => {
	let late: StepSubagentRunInput["onUpdate"];
	const { updates } = await run({ agent: "general", task: "inspect" }, async (input) => {
		late = input.onUpdate;
		input.onUpdate?.({ ...idle, activeText: "first" });
		return { ...idle, exitCode: 0, stopReason: "stop" };
	});
	const settled = updates.length;
	late?.({ ...idle, messages: [message(0, 100_000)], activeText: "late" });
	await new Promise((resolve) => setTimeout(resolve, 150));
	expect(updates.length).toBe(settled);
});

test("a consumer that throws on update fails the call instead of escaping a timer", async () => {
	const failure = new Error("host went away");
	await expect(
		run(
			{ agent: "general", task: "inspect" },
			async (input) => {
				input.onUpdate?.({ ...idle, activeText: "first" });
				return { ...idle, exitCode: 0, stopReason: "stop" };
			},
			{ onUpdateError: failure },
		),
	).rejects.toThrow("host went away");
});
