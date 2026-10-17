import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CHILD_SESSION_ORIGIN, createStepSessionManager, type NewSessionOptions } from "@step-harness/coding-agent";
import { listWorkflowChildren, readChildTranscript } from "../src/child-sessions.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A persisted session: the file is written once an assistant reply exists. */
function writeSession(agentDir: string, cwd: string, task: string, options?: NewSessionOptions) {
	const manager = createStepSessionManager(cwd, { agentDir, ...(options ? { newSession: options } : {}) });
	manager.appendMessage({ role: "user", content: task, timestamp: Date.now() });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: `done: ${task}` }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	});
	return manager;
}

test("reads a child transcript only through the parent that spawned it", async () => {
	const agentDir = await realpath(await mkdtemp(join(tmpdir(), "stepcode-web-children-")));
	try {
		const parent = writeSession(agentDir, "/work/app", "parent task");
		const parentId = parent.getSessionId();
		const childId = "subagent-0d6c0c7e-2b6f-4a55-9d0b-4b8f6d1a0001";
		writeSession(agentDir, "/work/app", "child task", {
			id: childId,
			origin: CHILD_SESSION_ORIGIN,
			parentSessionId: parentId,
		});
		// A child in another folder (an isolated worktree) is found through the session list.
		const farId = "subagent-0d6c0c7e-2b6f-4a55-9d0b-4b8f6d1a0002";
		writeSession(agentDir, "/work/other", "far task", {
			id: farId,
			origin: CHILD_SESSION_ORIGIN,
			parentSessionId: parentId,
		});
		const other = writeSession(agentDir, "/work/app", "unrelated user session");

		const child = await readChildTranscript(parentId, parent.getSessionFile(), childId, agentDir);
		assert.equal(child?.id, childId);
		assert.deepEqual(
			child?.entries.map((entry) => (entry.type === "message" ? entry.message.role : entry.type)),
			["user", "assistant"],
		);
		assert.equal((await readChildTranscript(parentId, parent.getSessionFile(), farId, agentDir))?.cwd, "/work/other");

		// Another parent, a plain user session, and malformed ids are all refused.
		assert.equal(await readChildTranscript(other.getSessionId(), other.getSessionFile(), childId, agentDir), undefined);
		assert.equal(
			await readChildTranscript(parentId, parent.getSessionFile(), other.getSessionId(), agentDir),
			undefined,
		);
		assert.equal(await readChildTranscript(parentId, parent.getSessionFile(), "../escape", agentDir), undefined);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("lists a workflow run's agents in agent order, including legacy children without a parent marker", async () => {
	const agentDir = await realpath(await mkdtemp(join(tmpdir(), "stepcode-web-children-")));
	try {
		const parent = writeSession(agentDir, "/work/app", "parent task");
		const parentId = parent.getSessionId();
		const run = "wf_9d3662f9aeec4041";
		writeSession(agentDir, "/work/app", "second agent", {
			id: `workflow-${run}-${run}-10`,
			origin: CHILD_SESSION_ORIGIN,
			parentSessionId: parentId,
		});
		// Written before children recorded their parent: only the id marks it.
		writeSession(agentDir, "/work/app", "first agent", { id: `workflow-${run}-${run}-2` });
		// Another parent's run with the same prefix shape is not listed.
		writeSession(agentDir, "/work/app", "foreign agent", {
			id: `workflow-${run}-${run}-3`,
			origin: CHILD_SESSION_ORIGIN,
			parentSessionId: "someone-else",
		});
		writeSession(agentDir, "/work/app", "other run", { id: "workflow-wf_other-wf_other-1" });

		const agents = await listWorkflowChildren(parentId, parent.getSessionFile(), run);
		assert.deepEqual(
			agents.map((agent) => [agent.id, agent.title, agent.messageCount]),
			[
				[`workflow-${run}-${run}-2`, "first agent", 2],
				[`workflow-${run}-${run}-10`, "second agent", 2],
			],
		);
		assert.deepEqual(await listWorkflowChildren(parentId, parent.getSessionFile(), "bad/run"), []);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});
