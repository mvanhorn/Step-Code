/**
 * Client-side shapes of what the StepCode Web host returns. They mirror
 * apps/web/src (runtime.ts snapshot(), files.ts, workspaces.ts, login.ts,
 * approval.ts) loosely: the client tolerates missing optional fields exactly as
 * the legacy app.js did.
 */

import type { TagColor } from "../i18n/messages";

export type SessionStatus = "idle" | "running" | "waiting" | "completed" | "failed";

export interface ModelRef {
	readonly provider: string;
	readonly id: string;
}

export interface ModelInfo extends ModelRef {
	readonly name?: string;
	readonly api?: string;
	readonly reasoning?: boolean;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	readonly input?: readonly string[];
	readonly cost?: unknown;
	/** Thinking levels this model supports (runtime.ts `projectModel`). */
	readonly thinkingLevels?: readonly string[];
}

/** GET /api/v1/models: what a new session in a folder would start on (runtime.ts `predictDraftModel`). */
export interface DraftModels {
	readonly model?: ModelRef;
	readonly thinkingLevel?: string;
	readonly availableThinkingLevels: readonly string[];
	readonly models: readonly ModelInfo[];
	/** The tier the Step settings name for this folder; a new session starts on it. */
	readonly permissionPreset?: string;
	/** The presets the picker offers, so a draft lists them before any session exists. */
	readonly policies?: readonly PolicyPreset[];
	/** Full Access was granted with "don't ask again"; picking it needs no confirmation. */
	readonly fullAccessAcknowledged?: boolean;
}

export interface PolicyPreset {
	readonly id: string;
	readonly label: string;
	readonly description: string;
}

export interface Usage {
	readonly input: number;
	readonly output: number;
	readonly [key: string]: unknown;
}

/** One content part of an agent message. */
export interface ContentPart {
	readonly type: string;
	readonly text?: string;
	readonly id?: string;
	readonly name?: string;
	readonly arguments?: unknown;
	readonly [key: string]: unknown;
}

export interface AgentMessage {
	readonly role: string;
	readonly content?: string | readonly ContentPart[];
	readonly toolCallId?: string;
	readonly isError?: boolean;
	readonly usage?: Usage;
	readonly [key: string]: unknown;
}

/** A projected session entry (runtime.ts `projectEntry`). */
export interface SessionEntry {
	readonly id: string;
	readonly type: string;
	readonly timestamp?: string;
	readonly message?: AgentMessage;
	readonly usage?: Usage;
	readonly [key: string]: unknown;
}

/** A row of GET /api/v1/sessions. Snapshots are merged into these rows too. */
export interface SessionSummary {
	readonly id: string;
	readonly cwd?: string;
	readonly name?: string;
	readonly firstMessage?: string;
	readonly allMessagesText?: string;
	readonly created?: string;
	readonly modified?: string;
	readonly messageCount?: number;
	readonly archived?: boolean;
	readonly cwdAvailable?: boolean;
	readonly status?: SessionStatus;
	readonly unread?: boolean;
	readonly [key: string]: unknown;
}

/** GET /api/v1/sessions/:id and the SSE `snapshot` event (runtime.ts `snapshot()`). */
export interface SessionSnapshot extends SessionSummary {
	readonly cwd: string;
	readonly status: SessionStatus;
	readonly sessionFile?: string;
	readonly entries?: readonly SessionEntry[];
	readonly model?: ModelRef;
	readonly permissionPreset?: string;
	readonly policies?: readonly PolicyPreset[];
	readonly thinkingLevel?: string;
	readonly availableThinkingLevels?: readonly string[];
	readonly models?: readonly ModelInfo[];
	/** Tool calls still waiting for a verdict; the stream only announces each one once. */
	readonly pendingApprovals?: readonly ApprovalRequest[];
	readonly pendingClarifications?: readonly ClarificationRequest[];
	/** Kernel selectors waiting for an answer (src/selection.ts), e.g. the Full Access risk question. */
	readonly pendingSelections?: readonly SelectionRequest[];
	/** User entry ids of turns whose file changes were reverted (runtime.ts `revertTurn`). */
	readonly revertedTurns?: readonly string[];
}

export interface ClarificationQuestion {
	readonly id: string;
	readonly label: string;
	readonly question: string;
	readonly reason?: string;
	readonly options: readonly { readonly label: string; readonly value: string; readonly description?: string }[];
	readonly allowFreeform: boolean;
}

/** A kernel `ui.select` dialog (src/selection.ts). Options are the kernel's own labels, echoed back verbatim. */
export interface SelectionRequest {
	readonly id: string;
	readonly sessionId: string;
	readonly title: string;
	readonly options: readonly string[];
}

export interface ClarificationRequest {
	readonly id: string;
	readonly sessionId: string;
	readonly questions: readonly ClarificationQuestion[];
}

export type ClarificationReply = { readonly id: string } & (
	| { readonly optionIndex: number }
	| { readonly text: string }
	| { readonly skipped: true }
);

export interface ApprovalRequest {
	readonly id: string;
	readonly sessionId: string;
	readonly toolName: string;
	readonly message: string;
	readonly input?: Readonly<Record<string, unknown>>;
	readonly reason?: string;
	readonly createdAt: number;
	readonly preview?: {
		readonly path?: string;
		readonly before?: string;
		readonly after?: string;
	};
}

export interface MessageTimelineItem {
	readonly itemId: string;
	readonly kind: "message";
	readonly entryId?: string;
	readonly role: string;
	readonly content: string;
	/** Images attached to a user message; a message can be images only. */
	readonly images?: number;
	readonly usage?: Usage;
	readonly timestamp?: string;
	/** The model request failed (assistant `stopReason: "error"`); the provider's message. */
	readonly error?: string;
}

export type ToolState = "pending" | "completed" | "failed";

export interface ToolTimelineItem {
	readonly itemId: string;
	readonly kind: "tool";
	readonly state: ToolState;
	readonly toolName: string;
	readonly inputSummary: string;
	readonly outputSummary: string;
	/** Full arguments and result, shown when the row is expanded. */
	readonly inputDetail?: string;
	readonly outputDetail?: string;
	/** A successful edit/write: its path argument and the unified patch from the result `details.patch`. */
	readonly change?: FileChange;
}

/** Why an edit/write has no patch (host `SkippedChange.reason`). */
export type UntrackedReason = "too_large" | "binary" | "unreadable" | "unknown";

export interface FileChange {
	readonly path: string;
	/** Unified patch, LF. Absent when none was recorded; then `untracked` says why. */
	readonly patch?: string;
	readonly untracked?: UntrackedReason;
}

/** Response of `POST /sessions/{id}/turns/{turnId}/revert`. */
export interface TurnRevertResult {
	readonly snapshot: SessionSnapshot;
	readonly paths: readonly string[];
	readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: UntrackedReason }>;
}

export interface ApprovalTimelineItem {
	readonly itemId: string;
	readonly kind: "approval";
	readonly approval: ApprovalRequest;
}

export type TimelineItem = MessageTimelineItem | ToolTimelineItem | ApprovalTimelineItem;

export interface WebWorkspace {
	readonly path: string;
	readonly name: string;
	/** False when the directory has since been moved or deleted. */
	readonly available: boolean;
	/** Removed from workspace navigation without deleting sessions. */
	readonly hidden?: boolean;
}

export interface LoginReport {
	readonly source: "environment" | "auth.json" | "none";
	readonly provider?: string;
	readonly profile?: string;
	readonly path?: string;
	readonly configured: boolean;
	readonly validity?: string;
	readonly loginCommand: string;
}

/** One of the four `step login` profiles (src/login.ts `LoginMethod`). */
export interface LoginMethod {
	readonly id: "step_plan" | "step_plan_oversea" | "platform_cn" | "platform_oversea";
	readonly credentialSource: "browser" | "apiKey";
	readonly region: "cn" | "global";
	readonly keyPageUrl: string;
}

/** `GET /api/v1/login/browser` (src/login.ts `BrowserLoginState`). */
export interface BrowserLoginState {
	readonly state: "idle" | "pending" | "completed" | "failed";
	readonly profile?: string;
	readonly authUrl?: string;
	readonly error?: string;
}

export interface BootstrapPayload {
	readonly cwd: string;
	readonly directoryPicker?: string;
	readonly login?: LoginReport | null;
}

export interface TreeEntry {
	readonly name: string;
	/** Path relative to the workspace root, with `/` separators. */
	readonly path: string;
	readonly kind: "directory" | "file";
}

export type WorkspaceFile =
	| { readonly kind: "text"; readonly path: string; readonly size: number; readonly content: string }
	| { readonly kind: "image"; readonly path: string; readonly size: number; readonly mimeType: string }
	| { readonly kind: "binary" | "too-large"; readonly path: string; readonly size: number };

/** GET /api/v1/directories (the in-page workspace browser). */
export interface DirectoryListing {
	readonly path: string;
	readonly parent: string;
	readonly directories: ReadonlyArray<{ readonly name: string; readonly path: string }>;
}

export interface TagGroup {
	readonly key: TagColor;
	readonly name: string;
}

/** A file staged for the next message. `data` is base64. */
export interface Attachment {
	readonly name: string;
	readonly mimeType: string;
	readonly data: string;
	readonly kind: "image" | "text";
}

/** GET /api/v1/sessions/:id/skills and /api/v1/workspace/skills (runtime.ts `WebSkill`). */
export interface WebSkill {
	readonly name: string;
	readonly description: string;
}

/** GET /api/v1/mcp (coding-agent `StepMcpStatus`). */
export interface McpServerStatus {
	readonly name: string;
	readonly status: "connecting" | "connected" | "failed" | "disabled";
	readonly toolCount: number;
	readonly error?: string;
}

/**
 * A server declaration as `config.toml` stores it (`StepMcpServerConfig`):
 * `command` for stdio, `url` for streamable HTTP.
 */
export interface McpServerConfig {
	readonly command?: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly url?: string;
	readonly http_headers?: Readonly<Record<string, string>>;
	readonly bearer_token_env_var?: string;
	readonly env_http_headers?: Readonly<Record<string, string>>;
	readonly startup_timeout_sec?: number;
	readonly tool_timeout_sec?: number;
	readonly enabled_tools?: readonly string[];
	readonly disabled_tools?: readonly string[];
	readonly oauth?: {
		readonly client_id?: string;
		readonly client_secret?: string;
		readonly scopes?: readonly string[];
		readonly callback_port?: number;
	};
	readonly enabled?: boolean;
}

/** `GET /api/v1/settings/mcp` entry (src/settings.ts `WebMcpServer`). */
export interface SettingsMcpServer {
	readonly name: string;
	readonly source: "user" | "plugin";
	readonly pluginName?: string;
	readonly transport: "stdio" | "http";
	readonly enabled: boolean;
	readonly config?: McpServerConfig;
	readonly status?: McpServerStatus["status"];
	readonly toolCount?: number;
	readonly error?: string;
}

/** `GET /api/v1/settings/plugins` (src/settings.ts `WebPluginCatalog`). */
export interface SettingsPluginCatalog {
	readonly installed: ReadonlyArray<{
		readonly id: string;
		readonly name: string;
		readonly version?: string;
		readonly description?: string;
		readonly mcpServers: readonly string[];
		readonly warnings: readonly string[];
	}>;
	readonly available: ReadonlyArray<{
		readonly name: string;
		readonly description?: string;
		readonly marketplace: string;
		readonly installed: boolean;
	}>;
	readonly marketplaces: ReadonlyArray<{
		readonly name: string;
		readonly kind: "builtin" | "git" | "local";
		readonly origin: string | null;
	}>;
	readonly warnings: readonly string[];
}

/** `GET /api/v1/settings/models` entry (src/model-providers.ts `WebModelProvider`). */
export interface SettingsModelProvider {
	readonly id: string;
	readonly name: string;
	readonly baseUrl: string;
	readonly api: string;
	readonly models: ReadonlyArray<{
		readonly id: string;
		readonly name?: string;
		readonly contextWindow?: number;
		readonly maxTokens?: number;
		readonly input?: readonly string[];
	}>;
	/** Where the key comes from; the key itself is never sent to the browser. */
	readonly credential: "stored" | "configured" | "none";
}

/** `POST /api/v1/settings/models/discover` candidate (providers `DiscoveredModel`). */
export interface DiscoveredModelEntry {
	readonly id: string;
	readonly name: string;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
}

/** `GET /api/v1/settings/skills` entry (src/settings.ts `WebSkillEntry`). */
export interface SettingsSkill {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly source: "user" | "plugin";
	readonly pluginName?: string;
	readonly location: string;
	readonly enabled: boolean;
	readonly toggleable: boolean;
	readonly deletable: boolean;
}
