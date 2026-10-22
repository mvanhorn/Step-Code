import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { api, apiSend, errorMessage } from "../../lib/api";
import { getDesktopBridge } from "../../platform/host";
import { openSession, refreshSessions } from "../../state/session";
import { useAppStore } from "../../state/store";
import type { ImportCandidate, ImportJob, ImportPreview } from "../../state/types";
import { Button, Icon, Popover, SearchInput } from "../../ui";
import { closeSettings } from "./actions";
import "./session-import.css";

const PATH = "/api/v1/session-imports";
const SOURCES = [
	{ id: "codex", name: "Codex" },
	{ id: "claude-code", name: "Claude Code" },
] as const;

function groupProjects<T>(rows: readonly T[], cwd: (row: T) => string) {
	const groups = new Map<string, T[]>();
	for (const row of rows) {
		const path = cwd(row);
		const items = groups.get(path) ?? [];
		items.push(row);
		groups.set(path, items);
	}
	return [...groups];
}

function projectName(path: string, fallback: string) {
	return path.split(/[\\/]/u).filter(Boolean).at(-1) || fallback;
}

export function SessionImportPage() {
	const t = useT();
	const sessions = useAppStore((state) => state.sessions);
	const [customPath, setCustomPath] = useState("");
	const [roots, setRoots] = useState<Readonly<Record<string, string>>>({});
	const [customOpen, setCustomOpen] = useState(false);
	const [includeArchived, setIncludeArchived] = useState(false);
	const [candidates, setCandidates] = useState<readonly ImportCandidate[]>([]);
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [previews, setPreviews] = useState<ReadonlyMap<string, ImportPreview>>(new Map());
	const [targets, setTargets] = useState<ReadonlyMap<string, string>>(new Map());
	const [query, setQuery] = useState("");
	const [scanned, setScanned] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [scanErrors, setScanErrors] = useState<readonly { source: string; message: string }[]>([]);
	const [focused, setFocused] = useState<string>();
	const [job, setJob] = useState<ImportJob>();
	const [jobs, setJobs] = useState<readonly ImportJob[]>([]);
	const mounted = useRef(true);

	useEffect(() => {
		mounted.current = true;
		void api<{ jobs: ImportJob[] }>(PATH)
			.then(({ jobs }) => {
				if (mounted.current) {
					setJobs(jobs);
					setJob(jobs.find((item) => item.status === "running"));
				}
			})
			.catch((caught: unknown) => {
				if (mounted.current) setError(errorMessage(caught));
			});
		return () => {
			mounted.current = false;
		};
	}, []);

	useEffect(() => {
		if (job?.status !== "running") return;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const poll = async () => {
			try {
				const next = await api<ImportJob>(`${PATH}/${job.id}`);
				if (stopped) return;
				setJob(next);
				setJobs((current) => [next, ...current.filter((item) => item.id !== next.id)]);
				if (next.status === "running") timer = setTimeout(() => void poll(), 500);
				else await refreshSessions();
			} catch (caught) {
				if (!stopped) {
					setError(errorMessage(caught));
					timer = setTimeout(() => void poll(), 2000);
				}
			}
		};
		void poll();
		return () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		};
	}, [job?.id, job?.status]);

	const pending = busy || job?.status === "running";
	const needle = query.trim().toLowerCase();
	const visible = candidates.filter((c) =>
		`${previews.get(c.id)?.title || c.title} ${c.cwd} ${c.source} ${c.sourcePath ?? ""}`
			.toLowerCase()
			.includes(needle),
	);
	const chosen = candidates.filter((c) => selected.has(c.id));
	const ready = chosen.length > 0 && chosen.every((c) => previews.has(c.id) && targets.get(c.id)?.trim());

	function selectionButton(rows: readonly ImportCandidate[], scope: string) {
		const all = rows.length > 0 && rows.every((row) => selected.has(row.id));
		return (
			<Button
				className="settings-btn subtle session-import-select-group"
				data-import-select={scope}
				disabled={pending || !rows.length}
				aria-pressed={all}
				onClick={(event) => {
					event.preventDefault();
					event.stopPropagation();
					setSelected((current) => {
						const next = new Set(current);
						for (const row of rows) {
							if (all) next.delete(row.id);
							else next.add(row.id);
						}
						return next;
					});
				}}
			>
				{t(all ? "importDeselectGroup" : "importSelectGroup")}
			</Button>
		);
	}

	async function scan(custom = false) {
		setBusy(true);
		setError("");
		try {
			const result = await apiSend<{
				roots?: Record<string, string>;
				candidates: ImportCandidate[];
				errors: { source: string; message: string }[];
			}>(`${PATH}/scan`, "POST", { ...(custom ? { customRoot: customPath.trim() } : {}), includeArchived });
			if (!mounted.current) return;
			setCandidates(result.candidates);
			setRoots(result.roots ?? {});
			setScanErrors(result.errors);
			setSelected(new Set());
			setPreviews(new Map());
			setTargets(new Map(result.candidates.map((c) => [c.id, c.cwd])));
			setFocused(undefined);
			setScanned(true);
			await preview(
				result.candidates.map((candidate) => candidate.id),
				false,
			);
		} catch (caught) {
			if (mounted.current) setError(errorMessage(caught));
		} finally {
			if (mounted.current) setBusy(false);
		}
	}

	async function preview(ids: readonly string[], show = true) {
		setBusy(true);
		setError("");
		if (show && ids[0]) setFocused(ids[0]);
		try {
			for (const id of ids) {
				try {
					const value = await apiSend<ImportPreview>(`${PATH}/preview`, "POST", { candidateId: id });
					if (!mounted.current) return;
					setPreviews((current) => new Map(current).set(id, value));
				} catch (caught) {
					if (mounted.current) setError((current) => `${current ? `${current}\n` : ""}${errorMessage(caught)}`);
				}
			}
		} finally {
			if (mounted.current) setBusy(false);
		}
	}

	async function pickSource() {
		try {
			const bridge = getDesktopBridge();
			const path = bridge
				? await bridge.pickDirectory({ title: t("importChooseSource") })
				: (await apiSend<{ path?: string }>("/api/v1/workspaces/pick", "POST", { title: t("importChooseSource") }))
						.path;
			if (!mounted.current || !path) return;
			setCustomPath(path);
		} catch (caught) {
			if (mounted.current) setError(errorMessage(caught));
		}
	}

	async function start() {
		if (!ready) return;
		setBusy(true);
		setError("");
		try {
			const next = await apiSend<ImportJob>(PATH, "POST", {
				selections: chosen.map((c) => ({
					candidateId: c.id,
					fingerprint: previews.get(c.id)?.fingerprint,
					cwd: targets.get(c.id),
				})),
			});
			if (mounted.current) {
				setJob(next);
				setJobs((current) => [next, ...current.filter((item) => item.id !== next.id)]);
			}
		} catch (caught) {
			if (mounted.current) setError(errorMessage(caught));
		} finally {
			if (mounted.current) setBusy(false);
		}
	}

	async function cancel() {
		if (!job) return;
		try {
			await apiSend(`${PATH}/${job.id}`, "DELETE");
		} catch (caught) {
			setError(errorMessage(caught));
		}
	}

	return (
		<div className="session-import-page">
			<section aria-labelledby="importSourcesTitle">
				<header className="session-import-section-head">
					<h1 id="importSourcesTitle">{t("importSourcesTitle")}</h1>
					<div className="session-import-header-actions">
						{chosen.length ? (
							<span className="session-import-selected">{t("importSelected", { count: chosen.length })}</span>
						) : null}
						<Button id="importScan" className="settings-btn" onClick={() => void scan()} disabled={pending}>
							<Icon name="search" size="sm" />
							{busy ? t("importWorking") : t("importScan")}
						</Button>
						<Button
							id="importConfirm"
							className="settings-btn primary"
							disabled={pending || !ready || chosen.length > 100}
							onClick={() => void start()}
						>
							{t("importConfirm")}
						</Button>
					</div>
				</header>
				{error ? (
					<p className="settings-alert danger session-import-error" role="alert">
						{error}
					</p>
				) : null}
				<div className="session-import-toolbar">
					<SearchInput
						wrapperClassName="search-input"
						aria-label={t("importSearch")}
						placeholder={t("importSearch")}
						value={query}
						onInputCapture={(event) => setQuery(event.currentTarget.value)}
					/>
					<label className="session-import-check">
						<input
							id="importIncludeArchived"
							type="checkbox"
							checked={includeArchived}
							onChange={(event) => setIncludeArchived(event.target.checked)}
							disabled={pending}
						/>
						{t("importIncludeArchived")}
					</label>
				</div>
				<div className="session-import-list">
					{SOURCES.map((source) => {
						const rows = visible.filter((candidate) => candidate.source === source.id);
						const count = candidates.filter((candidate) => candidate.source === source.id).length;
						const root = roots[source.id];
						if (!scanned || (!root && !count && !scanErrors.some((item) => item.source === source.id)))
							return null;
						return (
							<details className="session-import-group" data-import-app={source.id} key={source.id} open>
								<summary className="session-import-app-summary">
									<Icon name="chevronRight" size="sm" />
									<strong>{source.name}</strong>
									{root ? <small className="session-import-root mono">{root}</small> : null}
									<span>
										{t("importSelected", {
											count: candidates.filter(
												(candidate) => candidate.source === source.id && selected.has(candidate.id),
											).length,
										})}
									</span>
									{selectionButton(rows, source.id)}
								</summary>
								<div className="session-import-app-body">
									{!rows.length ? (
										<p className="empty-list">
											{t(
												!scanned ? "importBeforeScan" : count && needle ? "importNoMatches" : "importEmpty",
											)}
										</p>
									) : null}
									{groupProjects(rows, (candidate) => candidate.cwd).map(([cwd, projectRows]) => (
										<details className="session-import-project" data-import-project={cwd} key={cwd} open>
											<summary className="session-import-project-summary">
												<Icon name="chevronRight" size="xs" />
												<Icon name="folder" size="sm" />
												<strong>{projectName(cwd, t("importUnknownProject"))}</strong>

												<span>
													{t("importSelected", {
														count: candidates.filter(
															(candidate) =>
																candidate.source === source.id &&
																candidate.cwd === cwd &&
																selected.has(candidate.id),
														).length,
													})}
												</span>
												{selectionButton(projectRows, `${source.id}:${cwd}`)}
											</summary>
											<div className="session-import-project-body">
												{projectRows.map((candidate) => {
													const p = previews.get(candidate.id);
													return (
														<div
															className="session-import-row"
															key={candidate.id}
															data-import-source={candidate.source}
														>
															<label className="session-import-check">
																<input
																	type="checkbox"
																	checked={selected.has(candidate.id)}
																	disabled={pending}
																	aria-label={p?.title || candidate.title}
																	onChange={(event) => {
																		const next = new Set(selected);
																		if (event.target.checked) next.add(candidate.id);
																		else next.delete(candidate.id);
																		setSelected(next);
																	}}
																/>
																<span>
																	<strong>{p?.title || candidate.title}</strong>
																	<small>
																		{candidate.modified.slice(0, 10)}
																		{candidate.archived ? ` · ${t("importArchived")}` : ""}
																	</small>
																</span>
															</label>
															<Popover
																className="session-import-preview-popover"
																placement="bottom-end"
																role="region"
																aria-label={t("importPreview")}
																open={focused === candidate.id && !!p}
																onClose={() => setFocused(undefined)}
																content={
																	p ? (
																		<>
																			<strong>{p.title}</strong>
																			<pre>{p.excerpt}</pre>
																		</>
																	) : null
																}
															>
																<Button
																	className="settings-btn"
																	disabled={pending}
																	aria-expanded={focused === candidate.id && !!p}
																	onClick={() => {
																		if (focused === candidate.id) setFocused(undefined);
																		else void preview([candidate.id]);
																	}}
																>
																	{t("importPreview")}
																</Button>
															</Popover>

															{p ? (
																<div className="session-import-report">
																	<span>
																		{t("importCounts", {
																			messages: p.messageCount,
																			tools: p.toolCount,
																		})}
																	</span>
																	{p.warnings.map((warning) => (
																		<span key={warning.code}>
																			{t(`importWarning.${warning.code}` as Parameters<typeof t>[0])}{" "}
																			({warning.count})
																		</span>
																	))}
																</div>
															) : null}
														</div>
													);
												})}
											</div>
										</details>
									))}
									{scanErrors.filter((item) => item.source === source.id).length ? (
										<details className="session-import-errors">
											<summary>
												{t("importScanErrors", {
													count: scanErrors.filter((item) => item.source === source.id).length,
												})}
											</summary>
											{scanErrors
												.filter((item) => item.source === source.id)
												.map((item) => (
													<p key={`${item.source}:${item.message}`}>{item.message}</p>
												))}
										</details>
									) : null}
								</div>
							</details>
						);
					})}
				</div>
				<div className="session-import-custom">
					<Button
						id="importCustomToggle"
						className="session-import-custom-toggle"
						aria-expanded={customOpen}
						onClick={() => setCustomOpen(!customOpen)}
					>
						<Icon name="folder" size="sm" />
						<span aria-hidden="true">＋</span>
						{t("importCustomScan")}
					</Button>
					<div className="session-import-custom-form" hidden={!customOpen}>
						<p className="settings-page-desc">{t("importCustomScanHint")}</p>
						<label className="settings-field" htmlFor="importCustomPath">
							<div className="session-import-source-picker">
								<input
									id="importCustomPath"
									aria-label={t("importCustomScan")}
									className="settings-input mono"
									value={customPath}
									onInputCapture={(event) => setCustomPath(event.currentTarget.value)}
									disabled={pending}
								/>
								<Button className="settings-btn" disabled={pending} onClick={() => void pickSource()}>
									{t("importChooseSource")}
								</Button>
							</div>
						</label>
						<Button
							id="importCustomScan"
							className="settings-btn"
							disabled={pending || !customPath.trim()}
							onClick={() => void scan(true)}
						>
							{t("importScan")}
						</Button>
					</div>
				</div>
			</section>
			<section className="session-import-history" aria-labelledby="importHistoryTitle" aria-live="polite">
				<header className="session-import-section-head">
					<h2 id="importHistoryTitle">{t("importHistoryTitle")}</h2>
					{job?.status === "running" ? (
						<Button className="settings-btn" onClick={() => void cancel()}>
							{t("importCancel")}
						</Button>
					) : null}
				</header>
				{job ? (
					<p className="settings-page-desc">
						{t(`importJob.${job.status}`)} · {job.results.length}/{job.total}
					</p>
				) : null}
				{[...SOURCES, { id: "unknown", name: t("importUnknownSource") }].map((source) => {
					const rows = [...jobs]
						.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
						.flatMap((item) => item.results.map((result, index) => ({ result, index, job: item })))
						.filter(({ result }) => (result.source ?? "unknown") === source.id);
					if (source.id === "unknown" && !rows.length) return null;
					return (
						<details className="session-import-group" data-import-history-app={source.id} key={source.id} open>
							<summary className="session-import-app-summary">
								<Icon name="chevronRight" size="sm" />
								<strong>{source.name}</strong>
							</summary>
							<div className="session-import-app-body">
								{!rows.length ? <p className="empty-list">{t("importHistoryEmpty")}</p> : null}
								{groupProjects(
									rows,
									({ result }) =>
										sessions.find((session) => session.id === result.sessionId)?.cwd ||
										candidates.find((candidate) => candidate.id === result.candidateId)?.cwd ||
										"",
								).map(([cwd, projectRows]) => (
									<details className="session-import-project" data-import-history-project={cwd} key={cwd} open>
										<summary className="session-import-project-summary">
											<Icon name="chevronRight" size="xs" />
											<Icon name="folder" size="sm" />
											<strong>{projectName(cwd, t("importUnknownProject"))}</strong>
										</summary>
										<div className="session-import-project-body">
											{projectRows.map(({ result, index, job: item }) => (
												<div
													className="session-import-result"
													key={`${item.id}-${index}`}
													data-import-result={result.sessionId ?? result.candidateId}
												>
													<div>
														<strong>{result.title ?? t("importUnknownProject")}</strong>
														<p>
															{t(`importResult.${result.status}`)} ·{" "}
															{new Date(item.createdAt).toLocaleString()}
														</p>
														{result.error ? <p>{result.error}</p> : null}
														{result.warning ? <p>{result.warning}</p> : null}
													</div>
													{result.sessionId ? (
														<Button
															className="settings-btn"
															onClick={() => {
																closeSettings();
																if (result.sessionId) void openSession(result.sessionId);
															}}
														>
															{t("importOpen")}
														</Button>
													) : null}
												</div>
											))}
										</div>
									</details>
								))}
							</div>
						</details>
					);
				})}
			</section>
		</div>
	);
}
