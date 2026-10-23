/**
 * Composer feature slot, mounted by App.tsx inside `.composer-zone`:
 * `form#composer.composer` (legacy index.html 847-1007, app.js 2354-2985,
 * 3256-3273, 3508-3549, 3576-3583, 3818-3885).
 */

import "./composer.css";

import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { api, errorMessage } from "../../lib/api";
import { activeCwd, interruptCurrent, sessionTitle, showError, timelineFromEntries } from "../../state/session";
import { getState, type ModeId, setUi, useAppStore } from "../../state/store";
import type { SessionSnapshot, TreeEntry } from "../../state/types";
import { Icon } from "../../ui";
import { openFeedback } from "../conversation";
import { askSideQuestion } from "../files";
import { AttachmentList } from "./Attachments";
import {
	type ContextPackage,
	chooseMode,
	clearModes,
	modePrefix,
	packageSessionContext,
	type StagedPick,
	sendMessage,
	turnActive,
	updateQueued,
} from "./actions";
import { ClarificationPanel } from "./ClarificationPanel";
import { FileMenu, type FileMenuHandle } from "./FileMenu";
import { type FileQuery, fileCompletionText, sameFileQuery } from "./file-completion";
import { GoalStrip } from "./GoalStrip";
import { ModelMenu } from "./ModelMenu";
import { PerformanceBar } from "./PerformanceBar";
import { PlanStrip } from "./PlanStrip";
import { MODES, PlusMenu } from "./PlusMenu";
import { PolicyMenu } from "./PolicyMenu";
import { PromptInput } from "./PromptInput";
import {
	placeCaretAtEnd,
	promptFileQuery,
	promptFiles,
	promptText,
	replaceFileQuery,
	restorePrompt,
	setPromptText,
	snapshotPrompt,
	waitForUploads,
} from "./prompt-editor";
import { QueueDock } from "./QueueDock";
import { type SlashItem, SlashMenu, type SlashMenuHandle, slashQuery } from "./SlashMenu";

export { ImagePreview } from "./ImagePreview";
export { SelectionDialog } from "./SelectionDialog";
export { TextInputDialog } from "./TextInputDialog";

export interface ComposerProps {
	/**
	 * `#workspaceControl` from the workspace feature: a compact folder pill just
	 * above `.composer-card`, outside it. App passes it in so the composer does
	 * not import the workspace feature.
	 */
	readonly workspaceControl?: ReactNode;
	/**
	 * `#branchControl` from the git branch feature: the branch pill beside the
	 * workspace pill. Passed in for the same reason as `workspaceControl`.
	 */
	readonly branchControl?: ReactNode;
}

/** The three listbox popovers; only one is open at a time (legacy `setupPopover` `open()`). */
type ComposerMenu = "policy" | "plus" | "model";

export function Composer({ workspaceControl, branchControl }: ComposerProps) {
	const t = useT();
	const form = useRef<HTMLFormElement | null>(null);
	const prompt = useRef<HTMLDivElement | null>(null);
	const stageFiles = useRef<((files: readonly File[]) => void) | null>(null);
	const [openMenu, setOpenMenu] = useState<ComposerMenu | null>(null);
	const [query, setQuery] = useState<string | null>(null);
	const slash = useRef<SlashMenuHandle | null>(null);
	const files = useRef<FileMenuHandle | null>(null);
	const [pathQuery, setPathQuery] = useState<FileQuery | null>(null);
	const lastPathQuery = useRef<FileQuery | null>(null);
	const composing = useRef(false);
	const cwd = useAppStore(activeCwd);
	const selection = useAppStore((state) => `${state.current?.id ?? "draft"}\0${activeCwd(state)}`);
	const status = useAppStore((state) => state.current?.status);
	const waiting = status === "waiting";
	/** During a turn Enter queues the message and Cmd/Ctrl+Enter steers it (see `sendMessage`). */
	const active = useAppStore(turnActive);
	const queuedCount = useAppStore((state) => state.current?.queuedMessages?.length ?? 0);
	/*
	 * Whether `#prompt` holds text to send. While a turn runs, `#sendButton` is the stop button
	 * until the user types; then it queues the message. Edits that bypass `input`
	 * (`setPromptText`, `restorePrompt`) call `syncHasText` themselves.
	 */
	const [hasText, setHasText] = useState(false);
	/** Picked other-session contexts, one removable chip each, sent with the next message. */
	const [contextPackages, setContextPackages] = useState<readonly ContextPackage[]>([]);
	/** Picked skills and plugins, one light-purple icon chip each, sent with the next message. */
	const [stagedPicks, setStagedPicks] = useState<readonly StagedPick[]>([]);
	// Single-select and single-shot: at most one mode rides the next message.
	const modes = useAppStore((state) => state.modes);
	const activeMode = (Object.keys(modes) as ModeId[]).find((id) => modes[id]);
	const syncHasText = () => setHasText(Boolean(prompt.current && promptText(prompt.current).trim()));
	const stopMode = status === "running" && !hasText;

	const menu = (name: ComposerMenu) => ({
		open: openMenu === name,
		onOpen: () => setOpenMenu(name),
		onClose: () => setOpenMenu((value) => (value === name ? null : value)),
	});

	const syncFileQuery = useCallback(() => {
		const editor = prompt.current;
		if (!editor || document.activeElement !== editor) {
			// Dismissal survives returning focus to the same unchanged token.
			setUi({ fileCompletionOpen: false });
			return;
		}
		const next = composing.current ? null : promptFileQuery(editor);
		const changed = !sameFileQuery(lastPathQuery.current, next);
		lastPathQuery.current = next;
		setPathQuery((current) => (sameFileQuery(current, next) ? current : next));
		if (!next) setUi({ fileCompletionOpen: false });
		else if (changed) setUi({ fileCompletionOpen: true, slashMenu: null });
	}, []);

	const onValueInput = useCallback(
		(value: string) => {
			setHasText(Boolean(value.trim()));
			const next = slashQuery(value);
			setQuery(next);
			const view = getState().ui.slashMenu;
			if (next !== null) setUi({ slashMenu: "commands", fileCompletionOpen: false });
			else if (view) setUi({ slashMenu: null });
			syncFileQuery();
		},
		[syncFileQuery],
	);

	const onCompositionChange = useCallback((active: boolean) => {
		composing.current = active;
		if (active) {
			lastPathQuery.current = null;
			setPathQuery(null);
			setUi({ fileCompletionOpen: false });
		}
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: session/workspace replacement invalidates the active token.
	useEffect(() => {
		lastPathQuery.current = null;
		setPathQuery(null);
		setUi({ fileCompletionOpen: false });
		return () => setUi({ fileCompletionOpen: false });
	}, [selection]);

	useEffect(() => {
		if (waiting) setUi({ fileCompletionOpen: false });
	}, [waiting]);

	const pickFile = useCallback(
		(entry: TreeEntry, expected: FileQuery, drill: boolean) => {
			const editor = prompt.current;
			if (!editor || activeCwd() !== cwd || !getState().ui.fileCompletionOpen) return;
			if (!replaceFileQuery(editor, expected, fileCompletionText(entry, expected.quoted, drill))) {
				syncFileQuery();
				return;
			}
			if (!drill) setUi({ fileCompletionOpen: false });
		},
		[syncFileQuery, cwd],
	);

	const pickSlash = useCallback((item: SlashItem) => {
		const editor = prompt.current;
		if (!editor) return;
		setQuery(null);
		setPathQuery(null);
		lastPathQuery.current = null;
		setUi({ fileCompletionOpen: false });
		if (item.kind === "mcp") {
			// A status view, not a prompt: nothing is sent.
			setPromptText(editor, "");
			setHasText(false);
			setUi({ slashMenu: "mcp" });
		} else if (item.kind === "feedback") {
			// The product's own feedback dialog, which POSTs to the same kernel
			// submission the `/feedback` command uses. Nothing is sent as a prompt.
			setPromptText(editor, "");
			setHasText(false);
			setUi({ slashMenu: null });
			openFeedback();
		} else {
			// The kernel runs `/<command> [args]` and expands `/skill:<name> [request]`
			// into the skill's instructions on send.
			setPromptText(editor, item.kind === "command" ? `/${item.key} ` : `/skill:${item.key} `);
			setHasText(true);
			setUi({ slashMenu: null });
		}
		editor.focus();
		placeCaretAtEnd(editor);
	}, []);

	/** True from Enter until the prompt is cleared, so a second Enter while uploads finish sends nothing. */
	const sending = useRef(false);
	const submit = async (steer: boolean) => {
		const editor = prompt.current;
		if (!editor || sending.current) return;
		sending.current = true;
		try {
			// A chip has its upload id only once its upload settles; a failed one is removed.
			await waitForUploads();
			const text = promptText(editor).trim();
			const files = promptFiles(editor);
			if (!text) return;
			// `/btw` is a side question, not a message: it opens its own rail tab and
			// never becomes a user turn (the kernel command is the same one the CLI runs).
			const sideQuestion = /^\/btw(?:\s+([\s\S]+))?$/u.exec(text)?.[1]?.trim();
			if (sideQuestion) {
				setPromptText(editor, "");
				setHasText(false);
				setQuery(null);
				setUi({ slashMenu: null });
				void askSideQuestion(sideQuestion);
				return;
			}
			// `/feedback` needs a dialog, not a turn: opening the product's feedback
			// dialog keeps one submission path and sends no prompt. A comment typed
			// after it rides along, so both spellings file the same report with the
			// same evidence instead of the kernel running its own wizard. The match
			// has to be tested on the whole command: a bare `/feedback` has no
			// capture group, and reading the group alone would fall through to the
			// kernel.
			const feedbackCommand = /^\/feedback(?:\s+([\s\S]+))?$/u.exec(text);
			if (feedbackCommand) {
				setPromptText(editor, "");
				setHasText(false);
				setQuery(null);
				setUi({ slashMenu: null });
				openFeedback(undefined, feedbackCommand[1]?.trim() ?? "");
				return;
			}
			/*
			 * Staged chips shape the outgoing message: one command pick may lead
			 * it (the kernel runs a single slash command per message, and only
			 * when it starts with `/`), and note picks plus session-context
			 * blocks ride at the tail (ZCode's prompt-tail pattern).
			 */
			const lead = stagedPicks.find((pick) => pick.prefix);
			// A mode applies to this message only: it leads the text and is dropped
			// once the message is accepted, never toggled off by a second command.
			const mode = activeMode ? modePrefix(activeMode) : "";
			const tail = [
				...stagedPicks.filter((pick) => pick.note).map((pick) => pick.note),
				...contextPackages.map((item) => item.block),
			].join("\n\n");
			const command = lead ? `${lead.prefix} ` : "";
			// `/plan` has to come first or the kernel never runs it: a leading
			// `/skill:` would swallow it as an argument. The plan command expands a
			// skill that follows it.
			const head = activeMode === "plan" ? `${mode}${command}` : `${command}${mode}`;
			const outgoing = `${head}${text}${tail ? `\n\n${tail}` : ""}`;
			setQuery(null);
			setPathQuery(null);
			lastPathQuery.current = null;
			setUi({ slashMenu: null, fileCompletionOpen: false });
			const draft = snapshotPrompt(editor);
			setPromptText(editor, "");
			setHasText(false);
			if (!(await sendMessage(outgoing, files, steer))) {
				restorePrompt(editor, draft);
				syncHasText();
			} else {
				setContextPackages([]);
				setStagedPicks([]);
				clearModes();
			}
		} finally {
			sending.current = false;
		}
	};

	const onFormSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		void submit(false);
	};

	/** A mode picked in `#plusMenu`: stage it as a chip for the next message only. */
	const pickMode = useCallback((id: ModeId) => {
		chooseMode(id);
		prompt.current?.focus();
	}, []);

	/**
	 * A skill or plugin picked in `#plusMenu`: staged as one light-purple icon
	 * chip. A command pick (skill, plugin install) replaces the previous command
	 * pick — one slash command per message; a use-note pick (installed plugin)
	 * stacks as a tail note.
	 */
	const stagePick = useCallback((pick: StagedPick) => {
		setStagedPicks((picks) => [
			// A command pick replaces every command pick; a note pick only its twin.
			...picks.filter((item) =>
				pick.prefix ? !item.prefix : !(item.kind === pick.kind && item.name === pick.name),
			),
			pick,
		]);
		prompt.current?.focus();
	}, []);

	/** A skill picked in `#plusMenu`: the kernel expands `/skill:<name>` on send. */
	const pickSkill = useCallback(
		(name: string) => stagePick({ kind: "skill", name, icon: "wrench", prefix: `/skill:${name}` }),
		[stagePick],
	);

	/** A plugin picked in `#plusMenu`: installable ones lead with the install command, installed ones ride as a note. */
	const pickPlugin = useCallback(
		(name: string, installed: boolean) =>
			stagePick(
				installed
					? {
							kind: "plugin",
							name,
							icon: "puzzle",
							note: `（使用插件「${name}」提供的 MCP 服务器与技能完成本次任务。）`,
						}
					: { kind: "plugin", name, icon: "puzzle", prefix: `/plugin install ${name}` },
			),
		[stagePick],
	);

	/** A session picked in `#plusMenu`: package its context into a chip above the prompt. */
	const pickSession = useCallback(async (id: string) => {
		try {
			const snapshot = await api<SessionSnapshot>(`/api/v1/sessions/${id}`);
			const title = sessionTitle(snapshot);
			setContextPackages((packages) => [
				// One chip per session: picking again replaces, not stacks.
				...packages.filter((item) => item.sessionId !== id),
				{ sessionId: id, title, block: packageSessionContext(title, timelineFromEntries(snapshot.entries)) },
			]);
			prompt.current?.focus();
		} catch (error) {
			showError(errorMessage(error));
		}
	}, []);

	/** Cmd/Ctrl+Enter during a turn: steer the typed text, or with an empty prompt every queued message. */
	const steer = () => {
		const editor = prompt.current;
		if (!active || !editor) {
			form.current?.requestSubmit();
			return;
		}
		if (promptText(editor).trim()) {
			void submit(true);
			return;
		}
		if (queuedCount) void updateQueued({ kind: "steer" });
	};

	return (
		<form className="composer" id="composer" ref={form} onSubmit={(event) => onFormSubmit(event)}>
			<SlashMenu handle={slash} query={query} promptRef={prompt} onPick={pickSlash} />
			<FileMenu handle={files} cwd={cwd} query={pathQuery} promptRef={prompt} onPick={pickFile} />
			<ClarificationPanel />
			<div className="composer-pickers" id="composerPickers">
				{workspaceControl}
				{branchControl}
			</div>
			<GoalStrip />
			<PlanStrip />
			<QueueDock />
			<div className="composer-card">
				<AttachmentList />
				{contextPackages.length || stagedPicks.length || activeMode ? (
					<div className="attachment-list" id="contextChipList">
						{/* A mode is a chip, not prompt text: sending the message consumes it. */}
						{activeMode ? (
							<span className="attachment-chip pick-chip pick-chip--mode" id="modeChip">
								<Icon name={MODES.find((mode) => mode.id === activeMode)?.icon ?? "cube"} size="xs" />
								<span>{t(MODES.find((mode) => mode.id === activeMode)?.labelKey ?? "modeGoal")}</span>
								<button
									type="button"
									className="attachment-remove"
									title={t("removePick")}
									aria-label={t("removePick")}
									onClick={() => clearModes()}
								>
									<Icon name="close-sm" size="xs" />
								</button>
							</span>
						) : null}
						{stagedPicks.map((pick) => (
							<span
								className={
									pick.kind === "skill"
										? "attachment-chip pick-chip pick-chip--skill"
										: "attachment-chip pick-chip"
								}
								key={`${pick.kind}:${pick.name}`}
								title={pick.note ?? pick.prefix ?? pick.name}
							>
								<Icon name={pick.icon} size="xs" />
								<span>{pick.name}</span>
								<button
									type="button"
									className="attachment-remove"
									title={t("removePick")}
									aria-label={t("removePick")}
									onClick={() =>
										setStagedPicks((picks) =>
											picks.filter((item) => !(item.kind === pick.kind && item.name === pick.name)),
										)
									}
								>
									<Icon name="close-sm" size="xs" />
								</button>
							</span>
						))}
						{contextPackages.map((item) => (
							<span className="attachment-chip context-chip" key={item.sessionId}>
								<Icon name="file" size="xs" />
								<span title={item.title}>{item.title}</span>
								<button
									type="button"
									className="attachment-remove"
									title={t("removeSessionContext")}
									aria-label={t("removeSessionContext")}
									onClick={() =>
										setContextPackages((packages) =>
											packages.filter((entry) => entry.sessionId !== item.sessionId),
										)
									}
								>
									<Icon name="close-sm" size="xs" />
								</button>
							</span>
						))}
					</div>
				) : null}
				<PromptInput
					promptRef={prompt}
					disabled={waiting}
					onSubmit={() => form.current?.requestSubmit()}
					onSteer={steer}
					placeholder={
						active ? t(queuedCount ? "queuePlaceholderSteerAll" : "queuePlaceholderRunning") : undefined
					}
					onValueInput={onValueInput}
					onCaretChange={syncFileQuery}
					onCompositionChange={onCompositionChange}
					onMenuKey={(key) => files.current?.key(key) || slash.current?.key(key) || false}
					stageFilesRef={stageFiles}
				/>
				<div className="composer-controls">
					<PlusMenu
						{...menu("plus")}
						onPickMode={pickMode}
						onPickSkill={pickSkill}
						onPickPlugin={pickPlugin}
						onPickSession={(id) => void pickSession(id)}
						onFiles={(picked) => stageFiles.current?.(picked)}
					/>
					<PolicyMenu {...menu("policy")} />
					<div className="composer-right">
						<ModelMenu {...menu("model")} />
						{stopMode ? (
							<button
								className="send-button send-button--stop"
								id="stopRun"
								type="button"
								title={t("stopRun")}
								aria-label={t("stopRun")}
								onClick={() => void interruptCurrent()}
							>
								<Icon name="stop" />
							</button>
						) : (
							<button
								className="send-button"
								id="sendButton"
								type="submit"
								title={active ? t("queueMessage") : t("sendMessage")}
								aria-label={active ? t("queueMessage") : t("sendMessage")}
								disabled={waiting}
							>
								<Icon name="send" />
							</button>
						)}
					</div>
				</div>
			</div>
			<PerformanceBar />
		</form>
	);
}
