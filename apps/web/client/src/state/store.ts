import { useRef, useSyncExternalStore } from "react";
import type { Locale, TagColor } from "../i18n/messages";
import { readStorage, STORAGE_KEYS } from "../lib/storage";
import { isDesktopHost } from "../platform/host";
import type {
	Attachment,
	DirectoryListing,
	DraftModels,
	LoginReport,
	PolicyPreset,
	SessionSnapshot,
	SessionStatus,
	SessionSummary,
	TagGroup,
	TimelineItem,
	TreeEntry,
	WebWorkspace,
	WorkspaceFile,
} from "./types";

/* ── Tiny external store ─────────────────────────────────────────────────── */

export type Listener = () => void;
export type StateUpdater<S> = Partial<S> | ((state: S) => Partial<S>);

export interface Store<S> {
	getState(): S;
	/**
	 * Shallow-merge a patch into the state. The patch (or the updater's result)
	 * must be built immutably: never mutate a Map/Set/array/object that is
	 * already in the state — replace it. Listeners run synchronously.
	 */
	setState(updater: StateUpdater<S>): void;
	subscribe(listener: Listener): () => void;
}

export function createStore<S extends object>(initial: S): Store<S> {
	let state = initial;
	const listeners = new Set<Listener>();
	return {
		getState: () => state,
		setState(updater) {
			const patch = typeof updater === "function" ? updater(state) : updater;
			if (!patch || patch === state) return;
			let changed = false;
			for (const key of Object.keys(patch) as Array<keyof S>) {
				if (!Object.is(patch[key], state[key])) {
					changed = true;
					break;
				}
			}
			if (!changed) return;
			state = { ...state, ...patch };
			for (const listener of [...listeners]) listener();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

/* ── App state (legacy app.js `state`, lines 1-53) ───────────────────────── */

export type ThemeChoice = "system" | "light" | "dark";
export type ConversationView = "project" | "group";
export type ModeId = "goal" | "plan" | "ultraloop";
export type DirectoryPickerMode = "native" | "browse";

/** Lazy file tree of one workspace (legacy `state.tree`). */
export interface TreeState {
	readonly cwd: string;
	readonly children: ReadonlyMap<string, readonly TreeEntry[]>;
	readonly expanded: ReadonlySet<string>;
	readonly loading: ReadonlySet<string>;
	readonly truncated: ReadonlySet<string>;
	readonly errors: ReadonlyMap<string, string>;
	/** Server-side name search results; null when not searching. */
	readonly results: readonly TreeEntry[] | null;
	readonly resultsTruncated: boolean;
}

export interface PreviewTab {
	readonly cwd: string;
	readonly path: string;
	readonly file: WorkspaceFile | null;
	readonly error: string;
	readonly loading: boolean;
	/** Markdown shown rendered rather than as source. */
	readonly rendered: boolean;
}

/** The preview panel's turn-changes view (features/files/ChangesView). */
export interface ChangesViewState {
	/** User entry id of the turn shown. */
	readonly turnId: string;
	/** Shown paths whose diff is unfolded. */
	readonly expanded: ReadonlySet<string>;
	/** Path to scroll into view, and a counter so asking twice scrolls twice. */
	readonly focus: string | null;
	readonly focusSeq: number;
}

export interface PreviewState {
	/** `files` shows the tabs; `changes` the turn-changes view. */
	readonly mode: "files" | "changes";
	readonly changes: ChangesViewState | null;
	readonly tabs: readonly PreviewTab[];
	/** Index into `tabs`, -1 when there are none. */
	readonly active: number;
	readonly open: boolean;
	readonly wrap: boolean;
}

/** Pages of the settings view, in menu order. */
export type SettingsPage = "general" | "appearance" | "models" | "plugins" | "mcp" | "skills";

/**
 * What a settings editor edits. `mcp` with a name edits that server, without one
 * creates a server; `json` opens it on the JSON tab (the "import" entry).
 */
export type SettingsEditor =
	| { readonly kind: "mcp"; readonly name?: string; readonly json?: boolean }
	| { readonly kind: "model"; readonly id?: string }
	| { readonly kind: "skill" };

/**
 * Cross-feature UI flags. Legacy code toggled `hidden` / classes on fixed
 * elements from anywhere; here the owning feature renders from these flags and
 * any feature (or the shell's Escape chain) can flip them.
 */
export interface UiState {
	/** `.app.sidebar-hidden` */
	readonly sidebarHidden: boolean;
	/** Inline `--sidebar-width` on `.app` in px; null leaves the CSS default. */
	readonly sidebarWidth: number | null;
	/** Inline `--preview-width` on `.app` in px; null leaves the CSS default. */
	readonly previewWidth: number | null;
	/** `.app.resizing` while a resize handle is dragged. */
	readonly resizing: boolean;
	/** `#fileTree.open` */
	readonly fileTreeOpen: boolean;
	/** `#searchModal` visible */
	readonly searchOpen: boolean;
	/** `#workspacePopover` visible */
	readonly workspacePopoverOpen: boolean;
	/** `#workspaceBrowserModal` visible */
	readonly workspaceBrowserOpen: boolean;
	readonly workspaceRemoval: { readonly path: string; readonly pending: boolean } | null;
	/** `#settingsView`: the open settings page, or null while the workspace shows. */
	readonly settingsPage: SettingsPage | null;
	/** Full-width editor inside a settings page (new or edited MCP server, new skill). */
	readonly settingsEditor: SettingsEditor | null;
	/** Dialog above the settings view: add a marketplace, import a skill folder. */
	readonly settingsDialog: "marketplace" | "skillImport" | null;
	/** `#sessionMenu` (session context menu) at viewport coordinates. */
	readonly sessionMenu: { readonly sessionId: string; readonly x: number; readonly y: number } | null;
	/**
	 * `#tagPicker`, anchored to the bottom-right corner of the button that opened
	 * it (legacy `positionTagPicker`). `sessionId` is the legacy `state.tagTarget`.
	 */
	readonly tagPicker: {
		readonly sessionId: string;
		readonly anchorRight: number;
		readonly anchorBottom: number;
	} | null;
	/** `#authBanner` visible (a request returned 401). */
	readonly authExpired: boolean;
	/** `#loggedOutOverlay` visible. */
	readonly loggedOut: boolean;
	/** `#loginGate` visible: Desktop has no Step credential yet, and the app waits behind it. */
	readonly loginRequired: boolean;
	/** Incremented to ask the composer to focus `#prompt` (legacy `$("#prompt").focus()`). */
	readonly promptFocusRequest: number;
	/** Mid-pane view covering the conversation: `#cronView` or `#marketView` (`.market-view.open`). */
	readonly midView: "cron" | "market" | null;
	/** Open menu of the changes view: `turn`, `more`, or `file:<shown path>`. */
	readonly changesMenu: string | null;
	/** The composer's slash menu: matching commands, or the MCP server list picked from it. */
	readonly slashMenu: "commands" | "mcp" | null;
}

export interface ToastState {
	readonly message: string;
	readonly tone: "danger" | "neutral";
	/** Distinguishes two identical consecutive messages. */
	readonly seq: number;
}

export interface PendingTurn {
	readonly text: string;
	/** User messages in the timeline when it was sent; one more means the host has recorded it. */
	readonly userCount: number;
}

export interface AppState {
	readonly sessions: readonly SessionSummary[];
	readonly current: SessionSnapshot | null;
	readonly timelineItems: readonly TimelineItem[];
	/**
	 * A message sent but not yet in the session entries. The composer sets it on
	 * Enter so the stream shows the message and a thinking indicator at once,
	 * instead of after session creation, `agent_start` and the first token.
	 */
	readonly pendingTurn: PendingTurn | null;
	readonly bootstrapCwd: string;
	readonly draftCwd: string;
	readonly draftPolicy: string;
	/** `${provider}\u0000${modelId}` the user picked for a new session, or "" for the server's default. */
	readonly draftModel: string;
	/** Thinking level the user picked for a new session, or "" for the server's default. */
	readonly draftThinking: string;
	/** The server's prediction for a new session in `draftCwd` (`GET /api/v1/models`); null until loaded. */
	readonly draftModels: DraftModels | null;
	readonly statusById: ReadonlyMap<string, SessionStatus>;
	readonly unreadById: ReadonlyMap<string, boolean>;
	readonly foldedProjects: ReadonlySet<string>;
	readonly groups: readonly TagGroup[];
	/** session id -> tag colour */
	readonly tags: ReadonlyMap<string, TagColor>;
	readonly currentView: ConversationView;
	readonly currentFilter: TagColor | null;
	readonly login: LoginReport | null;
	/** The in-page workspace browser (legacy workspaceBrowserPath/Parent, workspaceDirectories). */
	readonly workspaceBrowser: DirectoryListing;
	readonly directoryPicker: DirectoryPickerMode;
	/** The system folder chooser request is pending (`#addWorkspace[aria-busy]`). */
	readonly pickingFolder: boolean;
	readonly tree: TreeState;
	/** Expanded folders remembered per workspace for this page load. */
	readonly treeExpandedByCwd: ReadonlyMap<string, ReadonlySet<string>>;
	readonly workspaces: readonly WebWorkspace[];
	readonly preview: PreviewState;
	readonly showArchived: boolean;
	readonly policiesCache: readonly PolicyPreset[];
	readonly modes: Readonly<Record<ModeId, boolean>>;
	readonly goalDraft: string;
	readonly attachments: readonly Attachment[];
	readonly theme: ThemeChoice;
	readonly locale: Locale;
	readonly ui: UiState;
	readonly toast: ToastState | null;
}

export function emptyTree(cwd = ""): TreeState {
	return {
		cwd,
		children: new Map(),
		expanded: new Set(),
		loading: new Set(),
		truncated: new Set(),
		errors: new Map(),
		results: null,
		resultsTruncated: false,
	};
}

function initialTheme(): ThemeChoice {
	const stored = readStorage(STORAGE_KEYS.theme);
	return stored === "light" || stored === "dark" ? stored : "system";
}

/**
 * A stored choice wins. Without one, Desktop follows the operating system's
 * language (Chromium reports it as `navigator.language`): Chinese stays
 * Chinese, anything else is English. A plain browser keeps the zh-CN default.
 */
function initialLocale(): Locale {
	const stored = readStorage(STORAGE_KEYS.locale);
	if (stored === "en-US" || stored === "zh-CN") return stored;
	if (!isDesktopHost() || typeof navigator === "undefined") return "zh-CN";
	const system = navigator.languages?.[0] ?? navigator.language ?? "";
	return system.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function createInitialState(): AppState {
	return {
		sessions: [],
		current: null,
		timelineItems: [],
		pendingTurn: null,
		bootstrapCwd: "",
		draftCwd: "",
		draftPolicy: "ask",
		draftModel: "",
		draftThinking: "",
		draftModels: null,
		statusById: new Map(),
		unreadById: new Map(),
		foldedProjects: new Set(),
		groups: [],
		tags: new Map(),
		currentView: "project",
		currentFilter: null,
		login: null,
		workspaceBrowser: { path: "", parent: "", directories: [] },
		directoryPicker: "browse",
		pickingFolder: false,
		tree: emptyTree(),
		treeExpandedByCwd: new Map(),
		workspaces: [],
		preview: {
			mode: "files",
			changes: null,
			tabs: [],
			active: -1,
			open: false,
			wrap: readStorage(STORAGE_KEYS.previewWrap) !== "0",
		},
		showArchived: false,
		policiesCache: [],
		modes: { goal: false, plan: false, ultraloop: false },
		goalDraft: "",
		attachments: [],
		theme: initialTheme(),
		locale: initialLocale(),
		ui: {
			// `?sb=0` starts with the sidebar collapsed (legacy bootstrap).
			sidebarHidden: typeof location !== "undefined" && location.search.includes("sb=0"),
			sidebarWidth: null,
			previewWidth: null,
			resizing: false,
			fileTreeOpen: false,
			searchOpen: false,
			workspacePopoverOpen: false,
			workspaceBrowserOpen: false,
			workspaceRemoval: null,
			settingsPage: null,
			settingsEditor: null,
			settingsDialog: null,
			sessionMenu: null,
			tagPicker: null,
			authExpired: false,
			loggedOut: false,
			loginRequired: false,
			promptFocusRequest: 0,
			midView: null,
			changesMenu: null,
			slashMenu: null,
		},
		toast: null,
	};
}

export const appStore: Store<AppState> = createStore(createInitialState());

export const getState = (): AppState => appStore.getState();
export const setState = (updater: StateUpdater<AppState>): void => appStore.setState(updater);

/** Merge a patch into `state.ui`. */
export function setUi(updater: Partial<UiState> | ((ui: UiState) => Partial<UiState>)): void {
	appStore.setState((state) => {
		const patch = typeof updater === "function" ? updater(state.ui) : updater;
		const unchanged = (Object.keys(patch) as Array<keyof UiState>).every((key) =>
			Object.is(patch[key], state.ui[key]),
		);
		return unchanged ? {} : { ui: { ...state.ui, ...patch } };
	});
}

/** Replace `state.tree` with the updater's result (return the same object to skip). */
export function setTree(updater: (tree: TreeState) => TreeState): void {
	appStore.setState((state) => ({ tree: updater(state.tree) }));
}

/** Replace `state.preview` with the updater's result. */
export function setPreview(updater: (preview: PreviewState) => PreviewState): void {
	appStore.setState((state) => ({ preview: updater(state.preview) }));
}

/* ── Immutable collection helpers ────────────────────────────────────────── */

export function mapWith<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): Map<K, V> {
	const next = new Map(map);
	next.set(key, value);
	return next;
}

export function mapWithout<K, V>(map: ReadonlyMap<K, V>, key: K): Map<K, V> {
	const next = new Map(map);
	next.delete(key);
	return next;
}

export function setWith<T>(set: ReadonlySet<T>, value: T): Set<T> {
	const next = new Set(set);
	next.add(value);
	return next;
}

export function setWithout<T>(set: ReadonlySet<T>, value: T): Set<T> {
	const next = new Set(set);
	next.delete(value);
	return next;
}

export function setToggled<T>(set: ReadonlySet<T>, value: T, include = !set.has(value)): Set<T> {
	return include ? setWith(set, value) : setWithout(set, value);
}

/* ── React binding ───────────────────────────────────────────────────────── */

export function shallowEqual<T>(left: T, right: T): boolean {
	if (Object.is(left, right)) return true;
	if (typeof left !== "object" || typeof right !== "object" || !left || !right) return false;
	if (Array.isArray(left) !== Array.isArray(right)) return false;
	const leftKeys = Object.keys(left);
	if (leftKeys.length !== Object.keys(right).length) return false;
	return leftKeys.every((key) =>
		Object.is((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
	);
}

/**
 * Subscribe a component to a slice of the app state.
 *
 * The selector may build a fresh object/array: the previous value is reused
 * when `isEqual` (default `Object.is`; pass `shallowEqual` for object slices)
 * says nothing changed, which keeps useSyncExternalStore from looping.
 */
export function useAppStore<T>(
	selector: (state: AppState) => T,
	isEqual: (left: T, right: T) => boolean = Object.is,
): T {
	const cache = useRef<{ state: AppState; selector: (state: AppState) => T; value: T } | null>(null);
	const getSnapshot = (): T => {
		const state = appStore.getState();
		const cached = cache.current;
		if (cached && cached.state === state && cached.selector === selector) return cached.value;
		const value = selector(state);
		if (cached && isEqual(cached.value, value)) {
			cache.current = { state, selector, value: cached.value };
			return cached.value;
		}
		cache.current = { state, selector, value };
		return value;
	};
	return useSyncExternalStore(appStore.subscribe, getSnapshot, getSnapshot);
}
