import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	isChildAgentSession,
	listAllStepSessions,
	readSessionBranch,
	resolveStepAgentDir,
	type SessionEntry,
	WORKFLOW_SESSION_ID_PREFIX,
} from "@step-harness/coding-agent";

/**
 * Read-only access to the transcripts of a session's child agents (subagent
 * lanes and workflow agents). A child is never opened as a `WebSession`: its
 * own process may still be appending to the file, and a user turn there would
 * fork the transcript the parent's agent is talking to. Files are only read.
 */

/** Session ids and workflow run ids are generated tokens; anything else is refused before touching the disk. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;

export function isChildLookupId(value: string): boolean {
	return ID_PATTERN.test(value);
}

export interface ChildTranscript {
	id: string;
	cwd: string;
	modified: string;
	entries: SessionEntry[];
}

export interface ChildSummary {
	id: string;
	/** The task the parent gave the child: its first user message, cut short. */
	title: string;
	messageCount: number;
	modified: string;
}

/** Session files are named `<timestamp>_<session id>.jsonl`; a bare `<session id>.jsonl` is read too. */
function idOfFile(name: string): string | undefined {
	if (!name.endsWith(".jsonl")) return undefined;
	return name.slice(name.indexOf("_") + 1, -".jsonl".length) || undefined;
}

async function filesIn(dir: string): Promise<Array<{ id: string; path: string }>> {
	try {
		return (await readdir(dir)).flatMap((name) => {
			const id = idOfFile(name);
			return id ? [{ id, path: join(dir, name) }] : [];
		});
	} catch {
		// A parent whose folder is gone has no readable children.
		return [];
	}
}

/**
 * The child's transcript, when `childId` names a child-agent session that
 * `parentId` may have spawned. A child that records its parent must name this
 * one; older children carry no parent, so the id marker is all there is.
 */
async function readChild(path: string, childId: string, parentId: string): Promise<ChildTranscript | undefined> {
	const read = await readSessionBranch(path).catch(() => undefined);
	if (!read || read.header.id !== childId || !isChildAgentSession(read.header)) return undefined;
	if (read.header.parentSessionId !== undefined && read.header.parentSessionId !== parentId) return undefined;
	const modified = await stat(path).then(
		(info) => info.mtime.toISOString(),
		() => read.header.timestamp,
	);
	return { id: childId, cwd: read.header.cwd, modified, entries: read.branch };
}

/**
 * Children usually write next to the parent (same cwd, same session folder).
 * A subagent run in another folder or a worktree lands elsewhere, so the full
 * session list is the fallback.
 */
export async function readChildTranscript(
	parentId: string,
	parentFile: string | undefined,
	childId: string,
	agentDir: string = resolveStepAgentDir(),
): Promise<ChildTranscript | undefined> {
	if (!isChildLookupId(childId)) return undefined;
	if (parentFile) {
		const local = (await filesIn(dirname(parentFile))).find((file) => file.id === childId);
		if (local) return readChild(local.path, childId, parentId);
	}
	const sessions = await listAllStepSessions({ agentDir, recursive: true });
	const found = sessions.find((session) => session.id === childId);
	return found ? readChild(found.path, childId, parentId) : undefined;
}

function firstUserText(entries: readonly SessionEntry[]): string {
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		const text =
			typeof content === "string"
				? content
				: content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join(" ");
		return text.replace(/\s+/gu, " ").trim().slice(0, 160);
	}
	return "";
}

/** Agent ids are `<runId>-<n>`; order by `n`, not by string. */
function agentOrdinal(id: string): number {
	const match = /-(\d+)$/u.exec(id);
	return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * The agents of workflow run `runId`. A workflow result does not list its
 * agents, but each one's session id is `workflow-<runId>-<agentId>`, and
 * workflow agents run in the parent's folder.
 */
export async function listWorkflowChildren(
	parentId: string,
	parentFile: string | undefined,
	runId: string,
): Promise<ChildSummary[]> {
	if (!parentFile || !isChildLookupId(runId)) return [];
	const prefix = `${WORKFLOW_SESSION_ID_PREFIX}${runId}-`;
	const files = (await filesIn(dirname(parentFile))).filter((file) => file.id.startsWith(prefix));
	const children = await Promise.all(files.map((file) => readChild(file.path, file.id, parentId)));
	return children
		.filter((child): child is ChildTranscript => child !== undefined)
		.sort((a, b) => agentOrdinal(a.id) - agentOrdinal(b.id))
		.map((child) => ({
			id: child.id,
			title: firstUserText(child.entries),
			messageCount: child.entries.filter((entry) => entry.type === "message").length,
			modified: child.modified,
		}));
}
