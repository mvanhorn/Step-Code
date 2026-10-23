/**
 * Step's plan-mode extension.
 *
 * The implementation follows Pi's plan-mode example, but uses Step's
 * model-facing tool names. State and interaction still go through Pi's
 * ExtensionAPI; there is no parallel plan state machine in the Step layer.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@step-harness/agent-core";
import type { EventBus } from "../core/event-bus.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../core/extensions/types.ts";
import { type StepTelemetryReporter, trackStepTelemetry } from "../step/telemetry.ts";
import { type LegacyPlanTodoFields, migrateLegacyPlanTodos } from "./plan-mode-migration.ts";
import {
	getPlanFilePath,
	hashPlanContents,
	registerPlanModeTools,
	type StepPlanExitOutcome,
	type StepPlanModeController,
} from "./plan-mode-tools.ts";

const PLAN_TOOLS = [
	"read_file",
	"find_files",
	"search_files",
	"list_directory",
	"run_command",
	"clarify_user",
	"write_file",
	"edit_file",
];
const MUTATING_TOOLS = new Set(["write_file", "edit_file", "write", "edit"]);
const PLAN_TASK_TOOLS = new Set([
	"enter_plan_mode",
	"exit_plan_mode",
	"task_create",
	"task_update",
	"task_get",
	"task_list",
]);

/** Who put the session into plan mode. */
export type StepPlanSource = "user" | "agent" | "unknown";

interface PlanState {
	enabled: boolean;
	toolsBeforePlanMode?: string[];
	planFilePath?: string;
	/** "user" for /plan or --plan, "agent" for enter_plan_mode. */
	planSource?: StepPlanSource;
	/**
	 * Hash of the proposal last handed to an external reviewer (rpc/headless).
	 * Kept while plan mode is off, so a later plan round can tell an untouched
	 * file from a new proposal.
	 */
	submittedPlanHash?: string;
	/**
	 * Hash of the plan file when this round entered plan mode (absent when there
	 * was no file). A proposal is new only if the model changed the file during
	 * the round: a leftover plan from an earlier round is not this request's
	 * answer, even when this process never saw it submitted.
	 */
	planHashAtEnter?: string;
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

const publishedPlanModes = new WeakMap<object, boolean>();
export function getStepPlanMode(manager: object): string {
	const value = publishedPlanModes.get(manager);
	return value === undefined ? "Unknown" : value ? "Plan" : "Default";
}

/** Latest plan state recorded on the branch, for hosts that render it. */
export interface StepPlanState {
	enabled: boolean;
	planFilePath?: string;
	planSource: StepPlanSource;
}

/**
 * Plan mode as of the latest `step-plan` entry on the branch.
 *
 * Reads persisted state rather than the in-memory WeakMap, so a host that
 * restores a session before the extension replays `session_start` still sees
 * the right answer. Undefined when the branch records no plan state at all.
 */
export function getStepPlanState(
	entries: readonly { type: string; customType?: string; data?: unknown }[],
): StepPlanState | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		if (entry.type !== "custom" || entry.customType !== "step-plan") continue;
		const data = entry.data as PlanState | undefined;
		if (!data || typeof data.enabled !== "boolean") continue;
		return {
			enabled: data.enabled,
			...(typeof data.planFilePath === "string" ? { planFilePath: data.planFilePath } : {}),
			planSource: data.planSource ?? "unknown",
		};
	}
	return undefined;
}

/**
 * Status-bar chip: "Planning (user|agent|unknown)" while plan mode is on,
 * cleared (normal) otherwise.
 */
function updateStatus(ctx: ExtensionContext, enabled: boolean, planSource: StepPlanSource | undefined): void {
	publishedPlanModes.set(ctx.sessionManager, enabled);
	if (enabled) {
		const label = `Planning (${planSource ?? "unknown"})`;
		// Styling is a presentation nicety: a host without a terminal theme must
		// still get the chip, not a crash inside its status update.
		const theme = ctx.ui.theme;
		ctx.ui.setStatus("plan-mode", theme ? theme.fg("warning", label) : label);
	} else {
		ctx.ui.setStatus("plan-mode", undefined);
	}
}

function recordPlanEnter(telemetry: StepTelemetryReporter | undefined, source: StepPlanSource): void {
	if (!telemetry) return;
	trackStepTelemetry(telemetry, "plan_mode_entered", { source });
}

function recordPlanExit(
	telemetry: StepTelemetryReporter | undefined,
	source: StepPlanSource | undefined,
	outcome: StepPlanExitOutcome,
): void {
	if (!telemetry) return;
	trackStepTelemetry(telemetry, "plan_mode_exited", { source: source ?? "unknown", outcome });
}

function recordPlanUpdate(
	telemetry: StepTelemetryReporter | undefined,
	source: StepPlanSource | undefined,
	created: boolean,
): void {
	if (!telemetry) return;
	trackStepTelemetry(telemetry, "plan_updated", { source: source ?? "unknown", created });
}

/** Hash of the plan file's current contents, or undefined when it cannot be read. */
function readPlanHash(planFilePath: string): string | undefined {
	try {
		return hashPlanContents(readFileSync(planFilePath, "utf8"));
	} catch {
		// Missing or unreadable: there is no earlier proposal to warn about, and
		// exit_plan_mode reports the real error if the model submits it.
		return undefined;
	}
}

/**
 * The request-local reminder sent while plan mode is on.
 *
 * It states the mode as a fact, not a hint: a model that is unsure probes with
 * enter_plan_mode and calls exit_plan_mode repeatedly, which users read as the
 * plan command not working.
 */
function planModeReminder(options: {
	planPath: string;
	planSource: StepPlanSource;
	canLeaveWithoutProposal: boolean;
	holdsEarlierPlan: boolean;
}): string {
	const origin =
		options.planSource === "user"
			? "The host turned it on because the user sent this request with /plan; you did not need to and must not call enter_plan_mode."
			: options.planSource === "agent"
				? "You turned it on with enter_plan_mode; do not call enter_plan_mode again."
				: "It was turned on earlier in this session; do not call enter_plan_mode.";
	const noPlan = options.canLeaveWithoutProposal
		? "If the request needs no plan (a question, a trivial edit), say so, leave the plan file untouched, call exit_plan_mode once (it then only leaves plan mode), and answer directly."
		: "If the request needs no plan (a question, a trivial edit), answer directly and tell the user they can turn plan mode off with /plan; exit_plan_mode only submits a written proposal here.";
	return [
		"<system-reminder>Plan mode is ON.",
		origin,
		"It stays on until you call exit_plan_mode or the user turns it off. This reminder is the current state: never call enter_plan_mode or exit_plan_mode to check it.",
		`Plan file: ${JSON.stringify(options.planPath)}.`,
		...(options.holdsEarlierPlan
			? ["It still holds content from before this request; overwrite it with the plan for this request."]
			: []),
		"Only this file may be written, with write_file or edit_file; every other file mutation is blocked.",
		"Explore first, write the complete plan there (goal, ordered steps with file paths, validation, open questions), then call exit_plan_mode exactly once to submit it.",
		"Do not carry the work out: implementation starts only after the user approves the plan.",
		noPlan,
		"</system-reminder>",
	].join(" ");
}

/** Create Step's native plan extension. */
export const createStepPlanExtension =
	(options: { telemetry?: StepTelemetryReporter } = {}): ExtensionFactory =>
	(pi: ExtensionAPI): void => {
		let enabled = false;
		let toolsBeforePlanMode: string[] | undefined;
		let planFilePath: string | undefined;
		let planSource: StepPlanSource | undefined;
		let submittedPlanHash: string | undefined;
		let planHashAtEnter: string | undefined;
		// The event bus is optional so minimal embedder/test harnesses that stub
		// ExtensionAPI keep working without one.
		const events = (pi as { events?: EventBus }).events;

		const persistPlanState = (): void => {
			pi.appendEntry("step-plan", {
				enabled,
				toolsBeforePlanMode,
				planFilePath,
				planSource,
				...(submittedPlanHash ? { submittedPlanHash } : {}),
				...(planHashAtEnter ? { planHashAtEnter } : {}),
			});
		};
		const enable = (): void => {
			toolsBeforePlanMode ??= pi.getActiveTools();
			// Keep plan-file writes available; tool_call restricts their target.
			pi.setActiveTools(unique([...toolsBeforePlanMode.filter((name) => !MUTATING_TOOLS.has(name)), ...PLAN_TOOLS]));
		};
		const restoreTools = (): void => {
			if (toolsBeforePlanMode) pi.setActiveTools(toolsBeforePlanMode);
			toolsBeforePlanMode = undefined;
		};
		const resolvePlanFilePath = (ctx: ExtensionContext): string =>
			planFilePath ?? getPlanFilePath(ctx.sessionManager.getSessionId(), ctx.cwd);
		const enter = (source: StepPlanSource, ctx: ExtensionContext): string => {
			enabled = true;
			planSource = source;
			planFilePath = resolvePlanFilePath(ctx);
			// What the file held before this round: an exit that finds the same
			// content has no proposal for this request, even if the file predates
			// the round (a previous plan, possibly from an older build).
			planHashAtEnter = readPlanHash(planFilePath);
			enable();
			recordPlanEnter(options.telemetry, source);
			updateStatus(ctx, enabled, planSource);
			persistPlanState();
			if (source === "user") {
				// An announcement, not an answer: the host renders plan mode from
				// session state, so this must not become a transcript row.
				ctx.ui.notify(
					`Plan mode enabled. Draft your proposal at ${planFilePath}; file-editing tools are limited to this path. Commands still use normal permissions.`,
					"info",
					{ transient: true },
				);
			}
			return planFilePath;
		};
		const exit = (outcome: StepPlanExitOutcome, ctx: ExtensionContext, submittedHash?: string): void => {
			recordPlanExit(options.telemetry, planSource, outcome);
			enabled = false;
			planSource = undefined;
			planHashAtEnter = undefined;
			if (submittedHash) submittedPlanHash = submittedHash;
			restoreTools();
			persistPlanState();
			updateStatus(ctx, enabled, planSource);
		};
		const planModeController: StepPlanModeController = {
			isPlanModeActive: () => enabled,
			enteredByUser: () => enabled && planSource === "user",
			enterPlanMode: (ctx) => enter("agent", ctx),
			exitPlanMode: exit,
			resolvePlanFilePath,
			wasSubmitted: (planHash) => submittedPlanHash === planHash,
			unchangedSinceEnter: (planHash) => planHashAtEnter !== undefined && planHashAtEnter === planHash,
		};

		pi.registerFlag("plan", {
			description: "Start in plan mode (draft a proposal for approval)",
			type: "boolean",
			default: false,
		});
		pi.registerCommand("plan", {
			description: "Toggle plan mode, or `/plan <task>` to start planning a task right away",
			handler: async (args, ctx) => {
				const prompt = args.trim();
				if (!prompt) {
					if (enabled) {
						exit("toggled_off", ctx);
						// State the host already draws; see enter().
						ctx.ui.notify("Plan mode disabled.", "info", { transient: true });
					} else {
						enter("user", ctx);
					}
					return;
				}
				// `/plan <task>` is "plan this", never "toggle": make sure plan mode is on,
				// then hand the task to the model as an ordinary user turn. Tool
				// restriction has already been applied by enter(), so the turn starts
				// with the plan-mode tool set. Slash commands run even mid-stream; queue
				// the task behind the current turn in that case instead of throwing.
				if (!enabled) enter("user", ctx);
				// Expand a leading `/skill:` or prompt template in the task, as the
				// same text sent without `/plan` would be (the Web composer puts its
				// plan prefix in front of a picked skill).
				pi.sendUserMessage(prompt, {
					expandPromptTemplates: true,
					...(ctx.isIdle() ? {} : { deliverAs: "followUp" as const }),
				});
			},
		});
		registerPlanModeTools(pi, planModeController);
		pi.on("tool_call", async (event, ctx) => {
			if (!enabled || !MUTATING_TOOLS.has(event.toolName)) return;
			const planPath = resolvePlanFilePath(ctx);
			const toolInput = event.input as Record<string, unknown>;
			const targetPath = typeof toolInput.path === "string" ? toolInput.path : "";
			if (targetPath && path.resolve(ctx.cwd, targetPath) === path.resolve(planPath)) {
				// Allowed: the mutation targets the plan file itself. This runs
				// before the write lands, so a missing file marks the plan's creation.
				recordPlanUpdate(options.telemetry, planSource, !existsSync(planPath));
				return;
			}
			return {
				block: true,
				reason: `Plan mode blocked this file mutation. Only the plan file may be written: ${planPath}\nTarget: ${targetPath || "(no path provided)"}`,
			};
		});

		// Plan mode has to be visible to the model, not only to the UI.
		//
		// A user who picks Plan sends `/plan <task>`: the command enters plan mode
		// and hands the task over as an ordinary user message, so without this the
		// model sees a normal request with a restricted tool set and can truthfully
		// say it was never told about plan mode. A model that is not told plainly
		// probes instead: it calls enter_plan_mode to "confirm" and exit_plan_mode
		// more than once. The reminder is request-local (it is never appended to
		// the session) and re-issued for each request while the mode is on, so it
		// survives compaction and tool changes. The same filter drops the copies an
		// earlier request added, and the hidden meta messages persisted by older
		// versions of this extension.
		pi.on("context", async (event, ctx) => {
			const messages = event.messages.filter((message) => {
				const candidate = message as AgentMessage & { customType?: string };
				return (
					candidate.customType !== "step-plan-context" && candidate.customType !== "step-plan-execution-context"
				);
			});
			if (!enabled) return { messages };
			const planPath = planFilePath ?? resolvePlanFilePath(ctx);
			const planHash = readPlanHash(planPath);
			return {
				messages: [
					...messages,
					{
						role: "custom" as const,
						customType: "step-plan-context",
						display: false,
						content: [
							{
								type: "text" as const,
								text: planModeReminder({
									planPath,
									planSource: planSource ?? "unknown",
									// Where no review dialog can be shown, exit_plan_mode without a new
									// proposal just leaves; the terminal refuses it and keeps planning.
									canLeaveWithoutProposal: ctx.mode === "rpc" || !ctx.hasUI,
									holdsEarlierPlan:
										planHash !== undefined &&
										(planHash === submittedPlanHash || planModeController.unchangedSinceEnter(planHash)),
								}),
							},
						],
						timestamp: Date.now(),
					},
				],
			};
		});

		const restorePlanState = (ctx: ExtensionContext, startWithPlan = false): void => {
			// Legacy tool lists predate these capabilities. Preserve only the ones
			// already active; ordinary tools still follow the saved branch selection.
			const activePlanTaskTools = pi.getActiveTools().filter((name) => PLAN_TASK_TOOLS.has(name));
			// Undo the previous branch's tool restriction before reading the new one.
			restoreTools();
			const planStates = [...ctx.sessionManager.getBranch()]
				.reverse()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === "step-plan"
						? [entry.data as (PlanState & LegacyPlanTodoFields) | undefined]
						: [],
				);
			const restoredPlanState = planStates[0];
			// Off snapshots omit transient tools; a preceding plan entry retains the baseline.
			const savedTools = planStates.find((state) => state?.toolsBeforePlanMode)?.toolsBeforePlanMode;
			enabled = restoredPlanState?.enabled ?? false;
			toolsBeforePlanMode = savedTools ? unique([...savedTools, ...activePlanTaskTools]) : undefined;
			planFilePath = restoredPlanState?.planFilePath;
			planSource = enabled ? (restoredPlanState?.planSource ?? "unknown") : undefined;
			submittedPlanHash = planStates.find((state) => state?.submittedPlanHash)?.submittedPlanHash;
			planHashAtEnter = enabled ? planStates.find((state) => state?.planHashAtEnter)?.planHashAtEnter : undefined;
			if (enabled) {
				planFilePath = resolvePlanFilePath(ctx);
				enable();
			} else {
				restoreTools();
			}
			if (restoredPlanState) {
				migrateLegacyPlanTodos({
					persistedPlanState: restoredPlanState,
					events,
					extensionContext: ctx,
					persistMigratedPlanState: persistPlanState,
				});
			}
			if (startWithPlan && !enabled) {
				enter("user", ctx);
				return;
			}
			updateStatus(ctx, enabled, planSource);
		};
		pi.on("session_start", async (event, ctx) => {
			restorePlanState(ctx, event.reason === "startup" && pi.getFlag("plan") === true);
		});
		pi.on("session_tree", async (_event, ctx) => restorePlanState(ctx));
	};

export const stepPlanExtension = createStepPlanExtension();
