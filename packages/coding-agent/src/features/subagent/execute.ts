/**
 * Blocking subagent orchestration: mode selection (single/parallel/chain),
 * task normalization, project-agent confirmation, per-task execution with
 * optional worktree isolation and telemetry, bounded-concurrency fan-out, and
 * result aggregation. Tool registration, rendering, and the child runner stay
 * in step-subagent.ts.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@step-harness/agent-core";
import type { Static } from "typebox";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import { type StepTelemetryReporter, trackStepTelemetry } from "../../step/telemetry.ts";
import {
	cloneUsage,
	emptyUsage,
	finalOutput,
	isFailed,
	makeToolResult,
	resultText,
	type StepChainItem,
	type StepSubagentDetails,
	type StepSubagentExtensionOptions,
	type StepSubagentResultRecord,
	type StepSubagentRunner,
	type StepSubagentRunResult,
	type StepTaskItem,
	type StepWorktreeLease,
	type StepWorktreeManager,
	type SubagentParams,
	sanitizeLabel,
} from "../step-subagent.ts";
import {
	discoverStepAgents,
	formatStepAgentCatalog,
	resolveStepAgent,
	type StepAgentConfig,
	type StepAgentDiscoveryResult,
	type StepAgentScope,
} from "../step-subagent-agents.ts";
import { acquireWorkflowAdmission } from "../workflow/admission.ts";
import {
	clampWorkflowConcurrency,
	configuredWorkflowConcurrencyLimit,
	type WorkflowSemaphore,
} from "../workflow/budget.ts";
import { truncateText } from "./lane-events.ts";
import type { StepSubagentLaneRuntime } from "./lane-lifecycle.ts";

/**
 * Live-update budget.
 *
 * A blocking call mirrors every child event into one `onUpdate`, and the Agent
 * Loop turns each of them into a `tool_execution_update` that hosts persist: the
 * `json`/`rpc` modes write one JSONL line per event, so the parent's event log
 * *is* this stream. Two independent properties keep that stream from growing
 * with the child's transcript:
 *
 * - `LIVE_UPDATE_INTERVAL_MS` caps the rate (the bash tool throttles at the same
 *   100ms; a faster cadence buys no visible UI change).
 * - The live projection drops `messages` entirely and keeps only the tail of the
 *   streamed text, so one update is bounded regardless of how much the child has
 *   produced. The full transcript is published once, in the final result.
 *
 * Without both, a 20-turn child emits ~1.4k updates that each carry the whole
 * transcript: 99% of the log is byte-identical repeats.
 */
const LIVE_UPDATE_INTERVAL_MS = 100;
const LIVE_TEXT_CHARS = 2_000;
const LIVE_TOOL_OUTPUT_CHARS = 1_000;
const LIVE_TOOL_ARGS_CHARS = 500;
const LIVE_TASK_CHARS = 600;
const LIVE_STDERR_CHARS = 2_000;
const LIVE_ERROR_CHARS = 2_000;
const LIVE_PROMPT_CHARS = 200;
const LIVE_CANCELLED_PROMPTS = 20;

/**
 * Final-result budget for the child transcript embedded in the tool result.
 *
 * The final details are persisted once per call, so this is not a rate problem,
 * but a long child can still hold megabytes of tool output that the parent never
 * renders. Keep the newest messages that fit; the final assistant text stays in
 * `activeText`, and `sessionFile`/`sessionId` point at the child's own
 * transcript for anything older. 64 KiB matches the cap the other hosts in this
 * repository apply to a persisted command result.
 */
const FINAL_MESSAGES_BYTES = 64 * 1024;
/** Display-only bounds on the final record; `content` carries the model-facing text. */
const FINAL_TEXT_CHARS = 8_000;
const FINAL_TASK_CHARS = 2_000;

export interface StepSubagentTaskInput {
	agent: string;
	task: string;
	cwd?: string;
	model?: string;
	contextMode?: "inherit" | "fresh";
	isolateWorkspace?: boolean;
	worktreeName?: string;
	retainWorktree?: boolean;
}

function statusForResult(result: StepSubagentRunResult): StepSubagentResultRecord["status"] {
	if (result.exitCode === -1) return "running";
	if (result.stopReason === "aborted") return "aborted";
	return isFailed(result) ? "failed" : "completed";
}

function resultRecord(
	agent: string,
	task: string,
	result: StepSubagentRunResult,
	extra: Partial<Pick<StepSubagentResultRecord, "agentSource" | "step" | "worktreePath" | "worktreeBranch">> = {},
): StepSubagentResultRecord {
	return {
		agent,
		agentSource: extra.agentSource ?? "unknown",
		task,
		status: statusForResult(result),
		...result,
		...extra,
		usage: cloneUsage(result.usage),
	};
}

function makeEmptyResult(agent: string, task: string): StepSubagentResultRecord {
	return {
		agent,
		agentSource: "unknown",
		task,
		status: "queued",
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		updatedAt: Date.now(),
	};
}

function makeSkippedResult(record: StepSubagentResultRecord): StepSubagentResultRecord {
	return { ...record, status: "skipped", updatedAt: Date.now() };
}

/**
 * The parent model only sees `content`, never `details`, so a chain's text must
 * carry both the outcome and the output that matters: the last completed step
 * on success, the stopping step's error otherwise. Earlier step bodies stay in
 * `details.results` instead of piling into the parent's context.
 */
function chainResultText(records: readonly StepSubagentResultRecord[]): string {
	const steps = records.map((record, index) => `${index + 1}. ${record.agent}: ${record.status}`).join("\n");
	const stopped = records.findIndex((record) => record.status !== "completed");
	if (stopped === -1) {
		const last = records.at(-1);
		if (!last) return "(no output)";
		return `Chain: ${records.length}/${records.length} steps completed\n${steps}\n\n### Final output (step ${records.length}, ${last.agent})\n\n${resultText(last)}`;
	}
	const failed = records[stopped];
	const sections = [
		`Chain stopped at step ${stopped + 1}/${records.length} (${failed.agent}: ${failed.status}); the chain did not complete.\n${steps}`,
		`### Error (step ${stopped + 1}, ${failed.agent})\n\n${resultText(failed)}`,
	];
	const previous = stopped > 0 ? records[stopped - 1] : undefined;
	if (previous) {
		sections.push(
			`### Last completed output (step ${stopped}, ${previous.agent})\n\n${truncateText(resultText(previous), 50_000)}`,
		);
	}
	return sections.join("\n\n");
}

function resultDetailsText(details: StepSubagentDetails): string {
	return details.results
		.map((result) => {
			const worktree = result.worktreePath ? ` worktree=${result.worktreePath}` : "";
			return `${result.agent}: ${result.status}${worktree}`;
		})
		.join("; ");
}

function buildDetails(
	mode: StepSubagentDetails["mode"],
	discovery: StepAgentDiscoveryResult,
	scope: StepAgentScope,
	results: StepSubagentResultRecord[],
): StepSubagentDetails {
	return {
		mode,
		agentScope: scope,
		userAgentsDir: discovery.userAgentsDir,
		projectAgentsDir: discovery.projectAgentsDir,
		results,
	};
}

/** Keep the tail of a streamed field within `max` characters, marker included. */
function tailChars(value: string | undefined, max: number): string | undefined {
	if (value === undefined || value.length <= max) return value;
	return `\u2026${value.slice(-(max - 1))}`;
}

/** Keep both ends of a prompt: the opening instruction and the inserted context. */
function clipMiddle(value: string, max: number): string {
	if (value.length <= max) return value;
	const half = Math.max(1, Math.floor((max - 1) / 2));
	return `${value.slice(0, half)}\u2026${value.slice(-half)}`;
}

/**
 * Project one record for a live update.
 *
 * This is an explicit allowlist, not a spread with a few fields patched: a
 * custom runner (or a future field) must not be able to smuggle unbounded state
 * into a payload that is emitted at 10 Hz. `messages` is deliberately empty —
 * the transcript changes only at `message_end`, so copying it per event
 * re-sends the same array hundreds of times between two of them.
 *
 * `task` matters most for a chain: `{previous}` splices the previous step's
 * entire output into the next step's task, so the expanded prompt can be as
 * large as the child's whole answer.
 */
function liveRecord(record: StepSubagentResultRecord): StepSubagentResultRecord {
	return {
		agent: record.agent,
		agentSource: record.agentSource,
		task: clipMiddle(record.task, LIVE_TASK_CHARS),
		status: record.status,
		exitCode: record.exitCode,
		messages: [],
		stderr: tailChars(record.stderr, LIVE_STDERR_CHARS) ?? "",
		usage: cloneUsage(record.usage),
		...(record.model === undefined ? {} : { model: record.model }),
		...(record.stopReason === undefined ? {} : { stopReason: record.stopReason }),
		...(record.errorMessage === undefined ? {} : { errorMessage: tailChars(record.errorMessage, LIVE_ERROR_CHARS) }),
		...(record.activeText === undefined ? {} : { activeText: tailChars(record.activeText, LIVE_TEXT_CHARS) }),
		...(record.activeTool === undefined ? {} : { activeTool: record.activeTool }),
		...(record.activeToolArgs === undefined
			? {}
			: { activeToolArgs: tailChars(record.activeToolArgs, LIVE_TOOL_ARGS_CHARS) }),
		...(record.activeToolOutput === undefined
			? {}
			: { activeToolOutput: tailChars(record.activeToolOutput, LIVE_TOOL_OUTPUT_CHARS) }),
		...(record.lastEvent === undefined ? {} : { lastEvent: record.lastEvent }),
		...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
		...(record.updatedAt === undefined ? {} : { updatedAt: record.updatedAt }),
		...(record.step === undefined ? {} : { step: record.step }),
		...(record.worktreePath === undefined ? {} : { worktreePath: record.worktreePath }),
		...(record.worktreeBranch === undefined ? {} : { worktreeBranch: record.worktreeBranch }),
		...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
		...(record.sessionFile === undefined ? {} : { sessionFile: record.sessionFile }),
		...(record.pendingReply === undefined ? {} : { pendingReply: record.pendingReply }),
		...boundedPrompts(record.cancelledPrompts),
	};
}

function boundedPrompts(prompts: string[] | undefined): { cancelledPrompts?: string[] } {
	if (!prompts || prompts.length === 0) return {};
	return {
		cancelledPrompts: prompts
			.slice(-LIVE_CANCELLED_PROMPTS)
			.map((prompt) => tailChars(prompt, LIVE_PROMPT_CHARS) ?? ""),
	};
}

/** Final transcript projection: newest messages that fit, plus why they were cut. */
function boundedMessages(messages: readonly unknown[]): {
	messages: StepSubagentRunResult["messages"];
	truncated: boolean;
} {
	if (messages.length === 0) return { messages: [], truncated: false };
	const kept: unknown[] = [];
	// Reserve the brackets and count each retained element's separating comma so
	// the check is on the serialized array, not on the sum of its members.
	let bytes = 2;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const size = Buffer.byteLength(JSON.stringify(messages[index]) ?? "", "utf8") + 1;
		if (bytes + size > FINAL_MESSAGES_BYTES) break;
		bytes += size;
		kept.push(messages[index]);
	}
	return {
		messages: kept.reverse() as StepSubagentRunResult["messages"],
		truncated: kept.length < messages.length,
	};
}

/**
 * Final record projection.
 *
 * The transcript is bounded, and so is every other field a consumer renders: a
 * runner that reports a multi-hundred-KB final answer must not put it in the
 * details, which several terminal events then echo. `activeText` is filled from
 * the transcript when a runner did not set it, so trimming `messages` can never
 * turn a completed record into "(no output)".
 */
function finalRecord(record: StepSubagentResultRecord): StepSubagentResultRecord {
	const bounded = boundedMessages(record.messages);
	// Fall back to the full transcript, not the bounded copy: one message larger
	// than the budget leaves `messages` empty, and the result must still render.
	const fallbackText = finalOutput(record.messages);
	return {
		...record,
		task: clipMiddle(record.task, FINAL_TASK_CHARS),
		messages: bounded.messages,
		activeText: tailChars(record.activeText || fallbackText, FINAL_TEXT_CHARS),
		activeToolArgs: tailChars(record.activeToolArgs, LIVE_TOOL_ARGS_CHARS),
		activeToolOutput: tailChars(record.activeToolOutput, LIVE_TOOL_OUTPUT_CHARS),
		stderr: tailChars(record.stderr, LIVE_STDERR_CHARS) ?? "",
		...(record.errorMessage === undefined ? {} : { errorMessage: tailChars(record.errorMessage, LIVE_ERROR_CHARS) }),
		...boundedPrompts(record.cancelledPrompts),
		...(bounded.truncated ? { messagesTruncated: true } : {}),
		usage: cloneUsage(record.usage),
	};
}

async function mapWithConcurrency<T, R>(
	items: readonly T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await fn(items[index], index);
		}
	});
	// Settle every worker before returning: a fail-fast rejection would otherwise
	// leave the other lanes running against an emitter the caller already closed.
	const settled = await Promise.allSettled(workers);
	const failed = settled.find((entry) => entry.status === "rejected");
	if (failed) throw failed.reason;
	return results;
}

function makeFailureResult(
	agent: string,
	task: string,
	message: string,
	source: StepAgentConfig["source"] | "unknown" = "unknown",
): StepSubagentResultRecord {
	return resultRecord(
		agent,
		task,
		{
			messages: [],
			stderr: message,
			exitCode: 1,
			usage: emptyUsage(),
			stopReason: "error",
			errorMessage: message,
		},
		{ agentSource: source },
	);
}

function taskLabel(task: StepSubagentTaskInput, index?: number): string {
	return sanitizeLabel(task.worktreeName ?? task.agent, index === undefined ? "agent" : `agent-${index + 1}`);
}

function taskFromParams(params: SubagentParams): StepSubagentTaskInput | undefined {
	const task = params.task?.trim();
	const agent = params.agent?.trim();
	if (!task || !agent) return undefined;
	return {
		agent,
		task,
		cwd: params.cwd,
		isolateWorkspace: params.isolateWorkspace,
		worktreeName: params.worktreeName,
		retainWorktree: params.retainWorktree,
	};
}

function normalizeTaskInput(task: Static<typeof StepTaskItem> | Static<typeof StepChainItem>): StepSubagentTaskInput {
	const runtimeTask = task as Static<typeof StepTaskItem> & {
		isolateWorkspace?: boolean;
		worktreeName?: string;
		retainWorktree?: boolean;
	};
	return {
		agent: task.agent,
		task: task.task,
		cwd: task.cwd,
		isolateWorkspace: runtimeTask.isolateWorkspace,
		worktreeName: runtimeTask.worktreeName,
		retainWorktree: runtimeTask.retainWorktree,
	};
}

async function confirmProjectAgents(
	ctx: ExtensionContext,
	params: SubagentParams,
	discovery: StepAgentDiscoveryResult,
	tasks: readonly StepSubagentTaskInput[],
): Promise<boolean> {
	if (params.confirmProjectAgents === false || !ctx.hasUI || ctx.isProjectTrusted()) return true;
	if (params.agentScope === "user") return true;
	const projectNames = [
		...new Set(
			tasks
				.map((task) => resolveStepAgent(discovery.agents, task.agent)?.name ?? task.agent)
				.filter((name) => discovery.agents.some((agent) => agent.name === name && agent.source === "project")),
		),
	];
	if (projectNames.length === 0) return true;
	return ctx.ui.confirm(
		"Run project-local agents?",
		`Agents: ${projectNames.join(", ")}\nSource: ${discovery.projectAgentsDir ?? "(unknown)"}\n\nProject definitions are repository-controlled. Continue only for a trusted repository.`,
	);
}

export type SubagentExecutionOptions = Required<
	Pick<
		StepSubagentExtensionOptions,
		"agentDir" | "configDirName" | "includeBuiltinAgents" | "maxParallelTasks" | "maxConcurrency"
	>
> & {
	worktreeManager: StepWorktreeManager;
	runner: StepSubagentRunner;
	telemetry?: StepTelemetryReporter;
};

/** A validated, approved call: discovery ran, exactly one mode was selected, and project agents were confirmed. */
export interface PreparedSubagentRun {
	mode: StepSubagentDetails["mode"];
	scope: StepAgentScope;
	discovery: StepAgentDiscoveryResult;
	tasks: StepSubagentTaskInput[];
}

export type SubagentPreflight =
	| { ok: true; run: PreparedSubagentRun }
	| { ok: false; result: AgentToolResult<StepSubagentDetails> };

/**
 * Everything that can reject a call before any child starts: discovery, mode
 * selection, the batch-size limit, and project-agent confirmation. With
 * `requireKnownAgents` an unknown agent name is rejected here as well, instead
 * of surfacing as one failed task; a background lane uses it so a bad call
 * returns an ordinary error and never creates a lane.
 */
export async function prepareSubagentRun(
	params: SubagentParams,
	ctx: ExtensionContext,
	options: SubagentExecutionOptions,
	preflight: { requireKnownAgents?: boolean } = {},
): Promise<SubagentPreflight> {
	const scope = params.agentScope ?? "user";
	const discovery = await discoverStepAgents(ctx.cwd, {
		agentDir: options.agentDir,
		configDirName: options.configDirName,
		includeBuiltin: options.includeBuiltinAgents,
		scope,
	});
	const parallelInput = params.tasks;
	const chainInput = params.chain;
	// This mirrors Pi's example: an empty optional array does not select a mode.
	const hasParallelInput = (parallelInput?.length ?? 0) > 0;
	const hasChainInput = (chainInput?.length ?? 0) > 0;
	const single = !hasParallelInput && !hasChainInput ? taskFromParams(params) : undefined;
	const parallel = hasParallelInput ? parallelInput!.map(normalizeTaskInput) : undefined;
	const chain = hasChainInput ? chainInput!.map(normalizeTaskInput) : undefined;
	const modeCount = Number(Boolean(single)) + Number(hasParallelInput) + Number(hasChainInput);
	if (modeCount !== 1) {
		const details = buildDetails("single", discovery, scope, []);
		return {
			ok: false,
			result: makeToolResult(
				details,
				`Invalid parameters. Provide exactly one mode. Available agents: ${formatStepAgentCatalog(discovery.agents)}`,
				true,
			),
		};
	}
	if (parallel && parallel.length > options.maxParallelTasks) {
		const details = buildDetails("parallel", discovery, scope, []);
		return {
			ok: false,
			result: makeToolResult(
				details,
				`Too many parallel tasks (${parallel.length}); maximum is ${options.maxParallelTasks}.`,
				true,
			),
		};
	}
	const tasks = parallel ?? chain ?? [single!];
	const mode: StepSubagentDetails["mode"] = chain ? "chain" : parallel ? "parallel" : "single";
	if (preflight.requireKnownAgents) {
		const unknown = [
			...new Set(tasks.filter((task) => !resolveStepAgent(discovery.agents, task.agent)).map((task) => task.agent)),
		];
		if (unknown.length > 0) {
			return {
				ok: false,
				result: makeToolResult(
					buildDetails(mode, discovery, scope, []),
					`Unknown agent${unknown.length > 1 ? "s" : ""}: ${unknown.map((name) => `"${name}"`).join(", ")}. Available agents: ${formatStepAgentCatalog(discovery.agents)}`,
					true,
				),
			};
		}
	}
	if (!(await confirmProjectAgents(ctx, params, discovery, tasks))) {
		const details = buildDetails(mode, discovery, scope, []);
		return { ok: false, result: makeToolResult(details, "Canceled: project-local agents not approved.", true) };
	}
	return { ok: true, run: { mode, scope, discovery, tasks } };
}

export async function executeSubagent(
	params: SubagentParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<StepSubagentDetails> | undefined,
	ctx: ExtensionContext,
	options: SubagentExecutionOptions,
	laneRuntime?: StepSubagentLaneRuntime,
): Promise<AgentToolResult<StepSubagentDetails>> {
	const preflight = await prepareSubagentRun(params, ctx, options);
	if (!preflight.ok) return preflight.result;
	return runPreparedSubagent(preflight.run, signal, onUpdate, ctx, options, laneRuntime);
}

export async function runPreparedSubagent(
	prepared: PreparedSubagentRun,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<StepSubagentDetails> | undefined,
	ctx: ExtensionContext,
	options: SubagentExecutionOptions,
	laneRuntime?: StepSubagentLaneRuntime,
): Promise<AgentToolResult<StepSubagentDetails>> {
	const parentCwd = ctx.cwd,
		parentSessionId = ctx.sessionManager?.getSessionId?.();
	const { mode, scope, discovery, tasks } = prepared;
	const parallel = mode === "parallel" ? tasks : undefined;
	const chain = mode === "chain" ? tasks : undefined;

	const records = tasks.map((task) => makeEmptyResult(task.agent, task.task));
	const execution = laneRuntime ? "background" : "blocking";
	const createdAt = tasks.map(() => Date.now());
	const createdTasks = new Set<number>();
	const reportCreated = (agent: StepAgentConfig, index: number): void => {
		if (!options.telemetry) return;
		createdTasks.add(index);
		trackStepTelemetry(options.telemetry, "subagent_task_created", {
			execution,
			agent_type: agent.name,
			model_profile: agent.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "inherited"),
		});
		createdAt[index] = Date.now();
	};
	const reportFinished = (record: StepSubagentResultRecord, index: number): void => {
		if (!options.telemetry || !createdTasks.has(index)) return;
		const status =
			record.status === "completed" ? "completed" : record.status === "aborted" ? "interrupted" : "error";
		trackStepTelemetry(options.telemetry, "subagent_task_finished", {
			execution,
			status,
			duration_ms: Math.max(0, Date.now() - (createdAt[index] ?? Date.now())),
		});
	};
	const statusKey = (): string => records.map((record) => record.status).join("\u0000");
	let lastStatusKey = "";
	let lastPublishAt = 0;
	let pendingPublish: ReturnType<typeof setTimeout> | undefined;
	/**
	 * Emission ownership. A consumer's `onUpdate` can throw, and after the timer
	 * fires that rejection no longer belongs to the caller's await chain. Capture
	 * it, stop emitting, and rethrow from the call's own path below, so one
	 * failing host cannot leave a timer publishing into a dead session.
	 */
	let closed = false;
	let publishError: unknown;

	const closeEmitter = (): void => {
		closed = true;
		if (pendingPublish) {
			clearTimeout(pendingPublish);
			pendingPublish = undefined;
		}
	};

	const publish = (mode: StepSubagentDetails["mode"]): void => {
		if (closed || !onUpdate) return;
		lastPublishAt = Date.now();
		lastStatusKey = statusKey();
		const live = buildDetails(mode, discovery, scope, records.map(liveRecord));
		onUpdate(makeToolResult(live, resultDetailsText(live)));
	};

	/** Run `publish`, attributing a failure to the call instead of the timer. */
	const publishSafely = (mode: StepSubagentDetails["mode"]): void => {
		try {
			publish(mode);
		} catch (error) {
			publishError ??= error;
			closeEmitter();
		}
	};

	/**
	 * Publish the live roster, coalescing streamed updates.
	 *
	 * A status transition is always published at once: it is the only change the
	 * live list shows besides the token counter, and readers rely on seeing every
	 * one of them. Everything in between (a streamed delta, a tool-output chunk)
	 * waits for the interval, with the latest records winning.
	 *
	 * Never throws; a consumer failure is surfaced once by `flushEmit`.
	 */
	const emit = (mode: StepSubagentDetails["mode"]): void => {
		if (closed || !onUpdate) return;
		const wait = LIVE_UPDATE_INTERVAL_MS - (Date.now() - lastPublishAt);
		if (statusKey() !== lastStatusKey || wait <= 0) {
			if (pendingPublish) {
				clearTimeout(pendingPublish);
				pendingPublish = undefined;
			}
			publishSafely(mode);
			return;
		}
		pendingPublish ??= setTimeout(() => {
			pendingPublish = undefined;
			publishSafely(mode);
		}, wait);
		pendingPublish.unref?.();
	};

	/** Publish the last coalesced update, close the emitter, and rethrow a consumer failure. */
	const flushEmit = (mode: StepSubagentDetails["mode"]): void => {
		if (pendingPublish) {
			clearTimeout(pendingPublish);
			pendingPublish = undefined;
			publishSafely(mode);
		}
		closeEmitter();
		if (publishError !== undefined) {
			const error = publishError;
			publishError = undefined;
			throw error instanceof Error ? error : new Error(String(error));
		}
	};

	const runOne = async (
		task: StepSubagentTaskInput,
		index: number,
		admission?: WorkflowSemaphore,
	): Promise<StepSubagentResultRecord> => {
		const agent = resolveStepAgent(discovery.agents, task.agent);
		if (!agent) {
			const failed = makeFailureResult(
				task.agent,
				task.task,
				`Unknown agent: "${task.agent}". Available agents: ${formatStepAgentCatalog(discovery.agents)}`,
			);
			records[index] = failed;
			emit(mode);
			reportFinished(failed, index);
			return failed;
		}
		reportCreated(agent, index);
		// A parallel batch shares the process-wide window with workflow nodes, so the
		// two together never exceed the host ceiling. The task stays queued until admitted.
		let releaseSlot: (() => void) | undefined;
		if (admission) {
			try {
				releaseSlot = await admission.acquire(signal);
			} catch (error) {
				const aborted = resultRecord(
					agent.name,
					task.task,
					{
						messages: [],
						stderr: "",
						exitCode: 1,
						usage: emptyUsage(),
						stopReason: "aborted",
						errorMessage: error instanceof Error ? error.message : String(error),
					},
					{ agentSource: agent.source },
				);
				records[index] = aborted;
				emit(mode);
				reportFinished(aborted, index);
				return aborted;
			}
		}
		let requestEpoch = admission?.epoch ?? 0;
		// Flip the queued placeholder before spawning, so the step reads as running
		// (with a clock) from the moment it is dispatched, not from its first event.
		records[index] = {
			...records[index],
			agentSource: agent.source,
			status: "running",
			startedAt: Date.now(),
			updatedAt: Date.now(),
		};
		emit(mode);
		const baseCwd = path.resolve(ctx.cwd, task.cwd ?? ".");
		let worktree: StepWorktreeLease | undefined;
		let childCwd = baseCwd;
		try {
			if (task.isolateWorkspace) {
				worktree = await options.worktreeManager.allocate(baseCwd, taskLabel(task, index));
				childCwd = worktree.path;
			}
			const childSessionId = laneRuntime?.sessionId
				? index === 0
					? laneRuntime.sessionId
					: `${laneRuntime.sessionId}-${index}`
				: `subagent-${randomUUID()}`;
			const withSession = (result: StepSubagentRunResult): StepSubagentRunResult => ({
				...result,
				sessionId: result.sessionId ?? childSessionId,
			});
			const update = (partial: StepSubagentRunResult): void => {
				records[index] = resultRecord(agent.name, task.task, withSession(partial), {
					agentSource: agent.source,
					worktreePath: worktree?.path,
					worktreeBranch: worktree?.branch,
				});
				emit(mode);
			};
			const child = await options.runner({
				parentCwd,
				parentSessionId,
				agent,
				task: task.task,
				cwd: childCwd,
				model: task.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
				thinkingLevel: ctx.thinkingLevel,
				signal,
				onUpdate: update,
				onNeedsInput: laneRuntime?.onNeedsInput,
				onChildRespawn: laneRuntime?.onChildRespawn,
				sessionId: childSessionId,
				keepAlive: laneRuntime?.keepAlive === true,
				...(laneRuntime?.turnTimeoutMs ? { turnTimeoutMs: laneRuntime.turnTimeoutMs } : {}),
				// An admitted child keeps its shared slot until its process has exited.
				...(admission ? { awaitExit: true } : {}),
				...(admission
					? {
							onModelRequest: (event) => {
								if (event.type === "started") requestEpoch = admission.epoch;
								else if (event.type === "succeeded") admission.succeeded(requestEpoch);
								else admission.throttle(requestEpoch, event.delayMs);
								if (event.type !== "started") requestEpoch = admission.epoch;
							},
						}
					: {}),
			});
			const completed = resultRecord(agent.name, task.task, withSession(child), {
				agentSource: agent.source,
				worktreePath: worktree?.path,
				worktreeBranch: worktree?.branch,
			});
			records[index] = completed;
			emit(mode);
			if (worktree && task.retainWorktree === false) await worktree.cleanup();
			reportFinished(completed, index);
			return completed;
		} catch (error) {
			if (worktree && task.retainWorktree === false) await worktree.cleanup().catch(() => undefined);
			const message = error instanceof Error ? error.message : String(error);
			const failed = makeFailureResult(agent.name, task.task, message, agent.source);
			records[index] = failed;
			emit(mode);
			reportFinished(failed, index);
			return failed;
		} finally {
			releaseSlot?.();
		}
	};

	// Publish the roster before dispatching. Every other emit happens inside
	// runOne, so without this the first update waits on a child's first streamed
	// event — process spawn, its mcp servers, then a first token — and the live
	// list stays invisible for the tens of seconds a caller most wants it. The
	// records are already seeded by makeEmptyResult, so this renders every lane
	// at 0s, including ones still queued behind maxConcurrency.
	emit(mode);
	try {
		if (parallel) {
			// The configured provider limit caps subagent batches the same way it caps workflows.
			const ceiling = Math.min(
				options.maxConcurrency,
				clampWorkflowConcurrency(configuredWorkflowConcurrencyLimit()),
			);
			const lease = acquireWorkflowAdmission(ceiling);
			try {
				await mapWithConcurrency(parallel, ceiling, (task, index) => runOne(task, index, lease.semaphore));
			} finally {
				lease.release();
			}
		} else if (chain) {
			let previous = "";
			for (let index = 0; index < chain.length; index++) {
				const task = {
					...chain[index],
					// Function replacement inserts `previous` verbatim. A string replacement would
					// let $-patterns in the prior subagent's output ($&, $`, $', $$) be reinterpreted
					// by String.prototype.replace, corrupting the next task's prompt.
					task: chain[index].task.replace(/\{previous\}/g, () => previous),
				};
				const record = await runOne(task, index);
				previous = finalOutput(record.messages) || resultText(record);
				if (record.status !== "completed") {
					for (let rest = index + 1; rest < chain.length; rest++) records[rest] = makeSkippedResult(records[rest]);
					emit(mode);
					break;
				}
			}
		} else await runOne(tasks[0], 0);
	} finally {
		// A trailing coalesced update must not outlive the call or be lost.
		flushEmit(mode);
	}
	const finalDetails = buildDetails(mode, discovery, scope, records.map(finalRecord));
	if (mode === "parallel") {
		const success = records.filter((record) => record.status === "completed").length;
		const summaries = records.map(
			(record) => `### ${record.agent} (${record.status})\n\n${truncateText(resultText(record), 50_000)}`,
		);
		return makeToolResult(
			finalDetails,
			`Parallel: ${success}/${records.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
		);
	}
	if (mode === "chain") return makeToolResult(finalDetails, chainResultText(records));
	const record = records[0];
	return makeToolResult(finalDetails, record ? resultText(record) : "(no output)");
}
