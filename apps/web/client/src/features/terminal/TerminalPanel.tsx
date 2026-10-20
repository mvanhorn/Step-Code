import { FitAddon } from "@xterm/addon-fit";
import { type ITheme, Terminal } from "@xterm/xterm";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { errorMessage } from "../../lib/api";
import { writeClipboard } from "../../lib/clipboard";
import { useAppStore } from "../../state/store";
import type { TerminalInfo, TerminalSnapshot } from "../../state/types";
import { Button, IconButton, Tooltip } from "../../ui";
import { closeTerminal, createTerminal, listTerminals, TerminalConnection, terminalWorkspaceKey } from "./actions";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

type View = { terminal: Terminal; fit: FitAddon; element: HTMLDivElement; seq: number; truncated: boolean };

function terminalTheme(): ITheme {
	const style = getComputedStyle(document.documentElement);
	const color = (name: string) => style.getPropertyValue(name).trim();
	return {
		background: color("--canvas"),
		foreground: color("--ink"),
		cursor: color("--ink"),
		selectionBackground: color("--focus-border"),
		black: color("--ink-2"),
		brightBlack: color("--ink-3"),
		red: color("--danger"),
		brightRed: color("--danger"),
		green: color("--success"),
		brightGreen: color("--success"),
		blue: color("--accent"),
		brightBlue: color("--accent"),
		white: color("--ink"),
		brightWhite: color("--ink"),
	};
}

export function TerminalPanel({ open }: { readonly open: boolean }) {
	const t = useT();
	const cwd = useAppStore((state) => state.current?.cwd || state.draftCwd || state.bootstrapCwd);
	const scope = terminalWorkspaceKey(cwd);
	const host = useRef<HTMLDivElement>(null);
	const views = useRef(new Map<string, View>());
	const connection = useRef<{ id: string; value: TerminalConnection } | undefined>(undefined);
	const current = useRef({ open, cwd });
	current.current = { open, cwd };
	const [infos, setInfos] = useState<readonly TerminalInfo[]>([]);
	const [selectedByCwd, setSelectedByCwd] = useState<Record<string, string>>({});
	const [pending, setPending] = useState(false);
	const [connected, setConnected] = useState(false);
	const [error, setError] = useState("");
	const [truncated, setTruncated] = useState(false);
	const [revision, setRevision] = useState(0);
	const tabs = infos.filter((info) => terminalWorkspaceKey(info.cwd) === scope);
	const selected = tabs.find((info) => info.id === selectedByCwd[scope]) || tabs[0];
	const selectedId = selected?.id;
	const selectedInfo = useRef(selected);
	selectedInfo.current = selected;
	const copy = async () => {
		const text = selectedId && views.current.get(selectedId)?.terminal.getSelection();
		if (!text) return;
		try {
			await writeClipboard(text);
		} catch {
			setError(t("terminalClipboardFailed"));
		}
	};
	const paste = async () => {
		if (!selectedId || !connected || selected?.status !== "running") return;
		try {
			const text = await navigator.clipboard.readText();
			if (selectedInfo.current?.id !== selectedId || !current.current.open) return;
			if (new TextEncoder().encode(text).byteLength > 65536) {
				setError(t("terminalPasteLimit"));
				return;
			}
			views.current.get(selectedId)?.terminal.paste(text);
			views.current.get(selectedId)?.terminal.focus();
		} catch {
			setError(t("terminalClipboardFailed"));
		}
	};
	const clipboard = useRef({ copy, paste });
	clipboard.current = { copy, paste };

	// biome-ignore lint/correctness/useExhaustiveDependencies: revision requests a list refresh after a mutation or reconnect.
	useEffect(() => {
		if (!open || !cwd) return;
		const controller = new AbortController();
		setError("");
		void listTerminals(cwd, controller.signal)
			.then((result) => {
				if (controller.signal.aborted) return;
				setInfos((old) => [...old.filter((info) => terminalWorkspaceKey(info.cwd) !== scope), ...result]);
				const live = new Set(result.map((info) => info.id));
				for (const [id, view] of views.current) {
					if (view.element.dataset.scope === scope && !live.has(id)) {
						view.terminal.dispose();
						view.element.remove();
						views.current.delete(id);
					}
				}
			})
			.catch((failure: unknown) => {
				if (!controller.signal.aborted) setError(errorMessage(failure));
			});
		return () => controller.abort();
	}, [open, cwd, scope, revision]);

	// Keep xterm instances while hidden; disconnect streams, never terminate shells.
	// biome-ignore lint/correctness/useExhaustiveDependencies: metadata updates must not reconnect the selected stream.
	useLayoutEffect(() => {
		for (const view of views.current.values()) view.element.hidden = true;
		setConnected(false);
		setTruncated(false);
		if (!open || !selected || !host.current) return;
		const id = selected.id;
		let view = views.current.get(id);
		if (!view) {
			const terminal = new Terminal({
				fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim(),
				fontSize: 13,
				lineHeight: 1.25,
				scrollback: 5000,
				screenReaderMode: true,
				cols: selected.cols,
				rows: selected.rows,
				theme: terminalTheme(),
				disableStdin: true,
				linkHandler: {
					activate: () => {
						/* Terminal output cannot open untrusted links automatically. */
					},
				},
			});
			const fit = new FitAddon();
			terminal.loadAddon(fit);
			const element = document.createElement("div");
			element.className = "terminal-view";
			element.dataset.terminalId = id;
			element.dataset.scope = scope;
			host.current.append(element);
			terminal.open(element);
			terminal.parser.registerOscHandler(52, () => true);
			terminal.onData((data) => {
				if (
					!terminal.options.disableStdin &&
					connection.current?.id === id &&
					selectedInfo.current?.status === "running"
				)
					connection.current.value.send("input", { data });
			});
			terminal.attachCustomKeyEventHandler((event) => {
				if (event.type !== "keydown") return true;
				const key = event.key.toLowerCase();
				if (
					(event.ctrlKey || event.metaKey) &&
					!event.altKey &&
					key === "c" &&
					(event.shiftKey || terminal.hasSelection())
				) {
					event.preventDefault();
					void clipboard.current.copy();
					return false;
				}
				if ((event.ctrlKey || event.metaKey) && !event.altKey && key === "v") {
					event.preventDefault();
					void clipboard.current.paste();
					return false;
				}
				return true;
			});
			view = { terminal, fit, element, seq: 0, truncated: false };
			views.current.set(id, view);
		}
		const active = view;
		active.element.hidden = false;
		active.terminal.textarea?.setAttribute("aria-label", t("terminalInput", { title: selected.title }));
		let live = true;
		let hydrated = false;
		let finishWrite: (() => void) | undefined;
		const fit = () => {
			if (!live || !hydrated || !host.current || host.current.clientWidth < 30 || host.current.clientHeight < 30)
				return;
			const dimensions = active.fit.proposeDimensions();
			if (!dimensions) return;
			const cols = Math.min(500, Math.max(2, dimensions.cols));
			const rows = Math.min(300, Math.max(1, dimensions.rows));
			if (cols === active.terminal.cols && rows === active.terminal.rows) return;
			active.terminal.resize(cols, rows);
			if (selectedInfo.current?.status === "running") client.send("resize", { cols, rows });
		};
		const client = new TerminalConnection(
			id,
			active.seq,
			async (snapshot: TerminalSnapshot) => {
				if (!live) return;
				setInfos((old) => old.map((info) => (info.id === id ? snapshot.info : info)));
				selectedInfo.current = snapshot.info;
				if (snapshot.truncated) {
					active.terminal.reset();
					active.seq = 0;
					active.truncated = true;
				}
				if (!hydrated) active.terminal.resize(snapshot.info.cols, snapshot.info.rows);
				const chunks = snapshot.chunks.filter((chunk) => chunk.seq > active.seq);
				// xterm owns the queued text even if the panel hides before parsing finishes.
				active.seq = snapshot.seq;
				if (chunks.length)
					await new Promise<void>((resolve) => {
						finishWrite = resolve;
						active.terminal.write(chunks.map((chunk) => chunk.data).join(""), () => {
							finishWrite = undefined;
							resolve();
						});
					});
				if (!live) return;
				hydrated = true;
				setTruncated(active.truncated);
				fit();
			},
			(ready, failure) => {
				if (!live) return;
				setConnected(ready);
				active.terminal.options.disableStdin = !ready || selectedInfo.current?.status !== "running";
				if (failure) setError(errorMessage(failure));
				else if (ready) setError("");
			},
			() => {
				if (!live) return;
				setInfos((old) => old.filter((info) => info.id !== id));
				setRevision((value) => value + 1);
			},
		);
		connection.current = { id, value: client };
		const observer = new ResizeObserver(fit);
		observer.observe(host.current);
		void client.connect();
		active.terminal.focus();
		return () => {
			live = false;
			finishWrite?.();
			observer.disconnect();
			client.close();
			active.terminal.options.disableStdin = true;
			if (connection.current?.value === client) connection.current = undefined;
		};
	}, [open, cwd, scope, selectedId, revision, t]);

	useEffect(() => {
		const observer = new MutationObserver(() => {
			for (const view of views.current.values()) view.terminal.options.theme = terminalTheme();
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme", "style", "class"],
		});
		return () => {
			observer.disconnect();
			connection.current?.value.close();
			for (const view of views.current.values()) {
				view.terminal.dispose();
				view.element.remove();
			}
			views.current.clear();
		};
	}, []);
	useEffect(() => {
		if (open && selectedId)
			views.current.get(selectedId)?.terminal.refresh(0, (views.current.get(selectedId)?.terminal.rows || 1) - 1);
	}, [open, selectedId]);
	const create = async () => {
		if (pending || !cwd) return;
		const directory = cwd;
		setPending(true);
		setError("");
		try {
			const snapshot = await createTerminal(directory);
			setInfos((old) => [...old.filter((info) => info.id !== snapshot.info.id), snapshot.info]);
			setSelectedByCwd((old) => ({ ...old, [terminalWorkspaceKey(directory)]: snapshot.info.id }));
		} catch (failure) {
			if (current.current.cwd === directory) setError(errorMessage(failure));
			setRevision((value) => value + 1);
		} finally {
			setPending(false);
		}
	};
	const close = async (id: string) => {
		setPending(true);
		try {
			await closeTerminal(id);
			setInfos((old) => old.filter((info) => info.id !== id));
			const view = views.current.get(id);
			view?.terminal.dispose();
			view?.element.remove();
			views.current.delete(id);
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			setPending(false);
		}
	};
	return (
		<section className="embedded-terminal" hidden={!open} aria-label={t("terminalTitle")}>
			<div className="terminal-tabs" role="tablist" aria-label={t("terminalTabs")}>
				{tabs.map((info) => (
					<div key={info.id} className={`terminal-tab${selectedId === info.id ? " is-active" : ""}`}>
						<button
							type="button"
							role="tab"
							id={`terminal-tab-${info.id}`}
							aria-selected={selectedId === info.id}
							aria-controls="terminal-output"
							onClick={() => setSelectedByCwd((old) => ({ ...old, [scope]: info.id }))}
						>
							{info.title}
						</button>
						<Tooltip content={t("terminalEnd")}>
							<IconButton
								icon="close"
								disabled={pending}
								aria-label={t("terminalEndNamed", { title: info.title })}
								onClick={() => void close(info.id)}
							/>
						</Tooltip>
					</div>
				))}
				<Tooltip content={t("terminalNew")}>
					<IconButton
						icon="plus"
						disabled={!cwd || pending || tabs.length >= 8}
						aria-label={t("terminalNew")}
						onClick={() => void create()}
					/>
				</Tooltip>
			</div>
			<div className="terminal-toolbar">
				<span>{selected?.title || t("terminalTitle")}</span>
				<Tooltip content={t("terminalCopy")}>
					<IconButton
						icon="copy"
						disabled={!selectedId}
						aria-label={t("terminalCopy")}
						onClick={() => void copy()}
					/>
				</Tooltip>
				<Tooltip content={t("terminalPaste")}>
					<IconButton
						icon="clipboardPaste"
						disabled={!connected || selected?.status !== "running"}
						aria-label={t("terminalPaste")}
						onClick={() => void paste()}
					/>
				</Tooltip>
				<Tooltip content={t("terminalClear")}>
					<IconButton
						icon="eraser"
						disabled={!selectedId}
						aria-label={t("terminalClear")}
						onClick={() => {
							if (selectedId) {
								views.current.get(selectedId)?.terminal.clear();
								views.current.get(selectedId)?.terminal.focus();
							}
						}}
					/>
				</Tooltip>
			</div>
			{error || selected?.error ? (
				<div className="terminal-error" role="alert">
					<span>{t("terminalError", { reason: error || selected?.error || "" })}</span>
					<Tooltip content={t("terminalReconnect")}>
						<IconButton
							icon="refresh"
							aria-label={t("terminalReconnect")}
							onClick={() => setRevision((value) => value + 1)}
						/>
					</Tooltip>
				</div>
			) : null}
			{truncated ? <output className="terminal-notice">{t("terminalTruncated")}</output> : null}
			<div
				id="terminal-output"
				className="terminal-output"
				role="tabpanel"
				aria-labelledby={selectedId ? `terminal-tab-${selectedId}` : undefined}
				ref={host}
			>
				{!selectedId ? (
					<div className="terminal-empty">
						<span>{t(cwd ? "terminalEmpty" : "terminalNoWorkspace")}</span>
						{cwd ? (
							<Button variant="secondary" disabled={pending} onClick={() => void create()}>
								{t("terminalNew")}
							</Button>
						) : null}
					</div>
				) : null}
			</div>
			<footer className="terminal-footer">
				<span>{cwd}</span>
				<span>
					{selected
						? selected.status === "running" && !connected
							? t("terminalConnecting")
							: t(`terminalStatus.${selected.status}`, { code: selected.exitCode ?? "?" })
						: ""}
				</span>
			</footer>
		</section>
	);
}
