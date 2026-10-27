import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { afterAll, afterEach, expect, test } from "vitest";
import { createStepSubagentExtension } from "../src/features/step-subagent.ts";
import { toJsonEvent } from "../src/modes/json-event.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

/**
 * End-to-end guard for the log amplification, on the real path.
 *
 * A real `--mode rpc` child process is spawned through the production rpc
 * adapter, parsed by the production event projection, executed by the
 * production orchestrator, dispatched by the real Agent Loop, and serialized by
 * `toJsonEvent` exactly as `--mode json` does. Only the parent's model is a test
 * double (faux provider) and the child's tokens are synthetic.
 *
 * The regression: every child event used to become one `tool_execution_update`
 * carrying the child's whole `messages` array, so the parent's log grew with the
 * square of the child's transcript.
 */

const childPath = fileURLToPath(new URL("./fixtures/subagent-stream-child.mjs", import.meta.url));
const harnesses: Harness[] = [];
// Copy the array: writing `process.argv[1]` mutates it in place, so storing the
// reference would make the restore a no-op.
const originalArgv = [...process.argv];
const originalExecArgv = [...process.execArgv];
const envBackup = { ...process.env };
// Keep the shared tool-output retention inside the test's own temp root instead
// of a developer's real agent directory.
const agentRoot = mkdtempSync(join(tmpdir(), "step-subagent-rpc-agent-"));

afterEach(() => {
	for (const key of [
		"STREAM_TURNS",
		"STREAM_DELTAS",
		"STREAM_TOOL_BYTES",
		"STREAM_DELAY_MS",
		"STREAM_FINAL_BYTES",
		"STEP_CODING_AGENT_DIR",
	]) {
		if (envBackup[key] === undefined) delete process.env[key];
		else process.env[key] = envBackup[key];
	}
	process.argv = originalArgv;
	process.execArgv = originalExecArgv;
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

afterAll(() => {
	rmSync(agentRoot, { recursive: true, force: true });
});

interface RunStats {
	logBytes: number;
	updateCount: number;
	largestUpdate: number;
	updatesWithMessages: number;
	finalMessagesBytes: number;
	/** Model-facing tool result text, which must stay complete. */
	finalText: string;
	/** Display-only `activeText` in the details, which must stay bounded. */
	finalActiveTextLength: number;
}

async function runAgainstRealChild(env: Record<string, string>): Promise<RunStats> {
	Object.assign(process.env, { STEP_CODING_AGENT_DIR: agentRoot, ...env });
	// The default runner spawns `process.argv[1]`; point it at the fake rpc child
	// and keep the parent's TS loader out of a plain-ESM child process.
	process.argv[1] = childPath;
	process.execArgv = process.execArgv.filter((arg) => !/^(?:--import|--loader|--require|-r)$/u.test(arg));

	const harness = await createHarness({
		extensionFactories: [{ name: "step-subagent", factory: createStepSubagentExtension({ agentDir: agentRoot }) }],
	});
	harnesses.push(harness);

	let logBytes = 0;
	const stats: RunStats = {
		logBytes: 0,
		updateCount: 0,
		largestUpdate: 0,
		updatesWithMessages: 0,
		finalMessagesBytes: 0,
		finalText: "",
		finalActiveTextLength: 0,
	};
	harness.session.subscribe((event) => {
		const bytes = Buffer.byteLength(JSON.stringify(toJsonEvent(event)), "utf8");
		logBytes += bytes;
		if (event.type === "tool_execution_update") {
			stats.updateCount += 1;
			stats.largestUpdate = Math.max(stats.largestUpdate, bytes);
			const results = event.partialResult?.details?.results;
			if (Array.isArray(results)) {
				for (const record of results) {
					if (Array.isArray(record?.messages) && record.messages.length > 0) stats.updatesWithMessages += 1;
				}
			}
		}
		if (event.type === "tool_execution_end") {
			const content: unknown[] = Array.isArray(event.result?.content) ? event.result.content : [];
			stats.finalText = content
				.filter(
					(part): part is { type: "text"; text: string } =>
						part !== null &&
						typeof part === "object" &&
						(part as { type?: unknown }).type === "text" &&
						typeof (part as { text?: unknown }).text === "string",
				)
				.map((part) => part.text)
				.join("\n");
			const records = event.result?.details?.results;
			if (Array.isArray(records)) {
				stats.finalMessagesBytes = Buffer.byteLength(
					JSON.stringify(records.map((record) => record?.messages ?? [])),
					"utf8",
				);
				stats.finalActiveTextLength = records.reduce(
					(sum, record) => sum + (typeof record?.activeText === "string" ? record.activeText.length : 0),
					0,
				);
			}
		}
	});
	stats.logBytes = logBytes;

	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("subagent", { agent: "general", task: "inspect" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("parent done"),
	]);
	await harness.session.prompt("delegate");
	stats.logBytes = logBytes;
	return stats;
}

test("a real rpc child streaming hundreds of events keeps the parent log bounded", async () => {
	const stats = await runAgainstRealChild({
		STREAM_TURNS: "10",
		STREAM_DELTAS: "40",
		STREAM_TOOL_BYTES: "20000",
		STREAM_DELAY_MS: "1",
	});

	// 10 turns x (40 deltas + a message_end + two tool events) is over 400 child
	// events. Before the fix that was >400 updates each carrying the transcript.
	expect(stats.updateCount).toBeGreaterThan(0);
	expect(stats.updateCount).toBeLessThan(60);
	expect(stats.updatesWithMessages).toBe(0);
	// Whole parent log, not just the updates: the transcript is published once.
	expect(stats.logBytes).toBeLessThan(1024 * 1024);
	expect(stats.finalMessagesBytes).toBeLessThanOrEqual(64 * 1024);
});

test("a huge final answer from a real child cannot escape the display budget", async () => {
	const stats = await runAgainstRealChild({
		STREAM_TURNS: "2",
		STREAM_DELTAS: "5",
		STREAM_TOOL_BYTES: "1000",
		STREAM_FINAL_BYTES: "300000",
	});

	// A 300 KB answer used to sit in `activeText` and be echoed by every terminal
	// event. The model-facing `content` stays complete; only the display copy is
	// bounded, so the parent log does not grow with the child's answer.
	// Model-facing text goes through the existing tool-result retention, so a
	// single 300 KB line becomes a pointer to a saved artifact. Either way the
	// answer never enters the event log at full size.
	expect(stats.finalText.length).toBeLessThan(100_000);
	expect(stats.finalText).toContain("Full output:");
	// The display copy in `details` is bounded by the orchestrator itself.
	expect(stats.finalActiveTextLength).toBeLessThanOrEqual(50_000);
	expect(stats.logBytes).toBeLessThan(1024 * 1024);
	expect(stats.largestUpdate).toBeLessThan(64 * 1024);
});
