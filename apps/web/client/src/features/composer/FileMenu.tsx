/** Workspace @path candidates, shared by Web and Desktop. The editor retains focus while picking or drilling. */

import { type RefObject, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useT } from "../../i18n";
import { api, errorMessage, workspaceApi } from "../../lib/api";
import { cx } from "../../lib/format";
import { getState, setUi, useAppStore } from "../../state/store";
import type { TreeEntry, WorkspaceFileCompletions } from "../../state/types";
import { Icon, IconButton, Kbd, useDismiss } from "../../ui";
import type { FileQuery } from "./file-completion";

export interface FileMenuHandle {
	/** True when the menu consumes a key; pending requests must not pick stale rows or submit the prompt. */
	readonly key: (key: string) => boolean;
}

interface FileMenuProps {
	readonly handle: RefObject<FileMenuHandle | null>;
	readonly promptRef: RefObject<HTMLDivElement | null>;
	readonly cwd: string;
	readonly query: FileQuery | null;
	readonly onPick: (entry: TreeEntry, query: FileQuery, drill: boolean) => void;
}

interface Candidates extends WorkspaceFileCompletions {
	readonly key: string;
	readonly loading: boolean;
	readonly error: string;
}

const EMPTY: Candidates = { key: "", entries: [], truncated: false, loading: false, error: "" };
const COMPLETION_DEBOUNCE_MS = 120;

export function FileMenu({ handle, promptRef, cwd, query, onPick }: FileMenuProps) {
	const t = useT();
	const visible = useAppStore((state) => state.ui.fileCompletionOpen);
	const open = visible && Boolean(cwd) && query !== null;
	const wanted = query?.query ?? "";
	const key = `${cwd}\0${wanted}`;
	const [result, setResult] = useState<Candidates>(EMPTY);
	const [active, setActive] = useState(0);
	const rootRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const current = result.key === key ? result : EMPTY;
	const pending = open && (result.key !== key || current.loading);
	const entries = open && !pending ? current.entries : [];
	const selected = Math.min(active, Math.max(0, entries.length - 1));

	useEffect(() => {
		if (!open) return;
		const controller = new AbortController();
		setActive(0);
		setResult({ ...EMPTY, key, loading: true });
		const timer = window.setTimeout(
			() => {
				api<WorkspaceFileCompletions>(workspaceApi(cwd, "/completions", { q: wanted }), {
					signal: controller.signal,
				})
					.then((data) => {
						if (!controller.signal.aborted) setResult({ ...data, key, loading: false, error: "" });
					})
					.catch((error: unknown) => {
						if (!controller.signal.aborted) setResult({ ...EMPTY, key, error: errorMessage(error) });
					});
			},
			!wanted || /[\\/]$/.test(wanted) ? 0 : COMPLETION_DEBOUNCE_MS,
		);
		return () => {
			window.clearTimeout(timer);
			controller.abort();
		};
	}, [open, cwd, wanted, key]);

	useEffect(() => {
		listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
		const editor = promptRef.current;
		if (!editor) return;
		if (open) editor.setAttribute("aria-controls", "fileCompletionList");
		if (entries.length) editor.setAttribute("aria-activedescendant", `fileCompletionOption-${selected}`);
		return () => {
			editor.removeAttribute("aria-controls");
			editor.removeAttribute("aria-activedescendant");
		};
	}, [open, entries.length, selected, promptRef]);

	useImperativeHandle(
		handle,
		() => ({
			key: (pressed) => {
				if (!open || !getState().ui.fileCompletionOpen || !query) return false;
				if (!["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(pressed)) return false;
				if (pending) return true;
				if (!entries.length) return false;
				if (pressed === "ArrowDown" || pressed === "ArrowUp") {
					setActive((selected + (pressed === "ArrowDown" ? 1 : -1) + entries.length) % entries.length);
				} else onPick(entries[selected], query, pressed === "Tab" && entries[selected].kind === "directory");
				return true;
			},
		}),
		[open, query, pending, entries, selected, onPick],
	);

	useDismiss({
		enabled: open,
		insideRefs: [rootRef, promptRef],
		escape: false,
		onDismiss: () => setUi({ fileCompletionOpen: false }),
	});

	return (
		<div id="fileCompletionMenu" className="slash-menu file-completion-menu" ref={rootRef} hidden={!open}>
			<div className="slash-group" id="fileCompletionTitle">
				{t("fileCompletionTitle")}
			</div>
			<div
				id="fileCompletionList"
				className="slash-list file-completion-list"
				role="listbox"
				aria-labelledby="fileCompletionTitle"
				aria-busy={pending}
				ref={listRef}
			>
				{entries.map((entry, index) => (
					<div
						key={entry.path}
						id={`fileCompletionOption-${index}`}
						role="option"
						tabIndex={-1}
						aria-selected={index === selected}
						data-path={entry.path}
						data-kind={entry.kind}
						className={cx("slash-item", "file-completion-item", index === selected && "active")}
						onMouseEnter={() => setActive(index)}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => query && onPick(entry, query, false)}
						onKeyDown={() => {}}
					>
						<Icon name={entry.kind === "directory" ? "folder" : "fileText"} size="sm" />
						<span className="file-completion-name">
							{entry.name}
							{entry.kind === "directory" ? "/" : ""}
						</span>
						<span className="file-completion-parent">
							{entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : ""}
						</span>
						{entry.kind === "directory" ? (
							<>
								{index === selected ? (
									<span className="file-completion-hint">
										{t("fileCompletionDrill")} <Kbd>Tab</Kbd>
									</span>
								) : null}
								<IconButton
									icon="chevronRight"
									iconSize="sm"
									className="file-completion-drill"
									tabIndex={-1}
									aria-label={t("fileCompletionOpenDirectory", { path: entry.path })}
									onMouseDown={(event) => event.preventDefault()}
									onClick={(event) => {
										event.stopPropagation();
										if (query) onPick(entry, query, true);
									}}
								/>
							</>
						) : null}
					</div>
				))}
			</div>
			{pending ? <output className="slash-empty">{t("fileCompletionLoading")}</output> : null}
			{!pending && current.error ? (
				<output className="slash-empty">{t("fileCompletionError", { reason: current.error })}</output>
			) : null}
			{!pending && !current.error && !entries.length ? (
				<output className="slash-empty">{t("fileCompletionEmpty")}</output>
			) : null}
			{!pending && current.truncated ? (
				<output className="file-completion-note">{t("fileCompletionTruncated")}</output>
			) : null}
		</div>
	);
}
