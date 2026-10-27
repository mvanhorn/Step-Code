/**
 * Local, offline reproduction of the subagent event-log amplification.
 *
 * Everything below is production code except the two test doubles the repo's
 * testing policy already sanctions:
 *   - the parent model (faux provider, no network),
 *   - the child (a fake `step --mode rpc` process that only streams tokens).
 *
 * The measured path is real end to end:
 *   child stdout -> routeSubagentRpcLine -> parseJsonEvent -> onUpdate
 *   -> execute.emit -> agent-loop tool_execution_update -> AgentSession event
 *   -> toJsonEvent -> the same JSONL a host redirects from `--mode json`.
 *
 * Run from packages/coding-agent:
 *   node --import tsx ../../docs/research/2026-10-27-subagent-live-update-amplification/repro.mts
 *   REPRO_TURNS=40 REPRO_DELTAS=150 REPRO_TOOL_BYTES=40000 node --import tsx <same>
 */
import { createHash } from "node:crypto";
import { createWriteStream, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { createStepSubagentExtension } from "../../../packages/coding-agent/src/features/step-subagent.ts";
import { toJsonEvent } from "../../../packages/coding-agent/src/modes/json-event.ts";
import { createHarness } from "../../../packages/coding-agent/test/suite/harness.ts";

const childPath = fileURLToPath(new URL("./child.mjs", import.meta.url));
const workDir = mkdtempSync(join(tmpdir(), "step-amp-"));
const logPath = join(workDir, "stepcode.jsonl");

// The default runner spawns `process.argv[1]`. Point it at the fake rpc child so
// this repro works on any branch, without the host-only `cliPath` option.
process.argv[1] = childPath;
// The child is plain ESM: do not forward the parent's tsx loader into it, or it
// will try to resolve `tsx` from the child's own cwd.
process.execArgv = process.execArgv.filter(
	(arg) => !/^(?:--import|--loader|--require|-r)$/u.test(arg),
);

const harness = await createHarness({
	extensionFactories: [
		{ name: "step-subagent", factory: createStepSubagentExtension({ agentDir: join(workDir, "agent") }) },
	],
});

// Mirror `--mode json`: every session event is one JSONL line on stdout.
const out = createWriteStream(logPath);
const stats = {
	byType: new Map<string, number>(),
	bytesByType: new Map<string, number>(),
	updates: 0,
	updatePayloadBytes: 0,
	updateMessagesBytes: 0,
	largestUpdate: 0,
	snapshotHashes: new Map<string, number>(),
	snapshotEmissions: 0,
	finalResultBytes: 0,
	finalResultMessages: 0,
};
let writeChain: Promise<void> = Promise.resolve();
let peakRss = 0;
const sampler = setInterval(() => {
	peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 10);

harness.session.subscribe((event) => {
	const line = JSON.stringify(toJsonEvent(event));
	const bytes = Buffer.byteLength(line, "utf8");
	stats.byType.set(event.type, (stats.byType.get(event.type) ?? 0) + 1);
	stats.bytesByType.set(event.type, (stats.bytesByType.get(event.type) ?? 0) + bytes);
	writeChain = writeChain.then(
		() => new Promise<void>((resolve) => (out.write(`${line}\n`) ? resolve() : out.once("drain", () => resolve()))),
	);
	if (event.type === "tool_execution_end") {
		stats.finalResultBytes = Buffer.byteLength(JSON.stringify(event.result), "utf8");
		const records = event.result?.details?.results;
		stats.finalResultMessages = Array.isArray(records)
			? records.reduce<number>(
					(sum, record) => sum + (Array.isArray(record?.messages) ? record.messages.length : 0),
					0,
				)
			: 0;
		return;
	}
	if (event.type !== "tool_execution_update") return;
	stats.updates += 1;
	stats.updatePayloadBytes += bytes;
	stats.largestUpdate = Math.max(stats.largestUpdate, bytes);
	const results = event.partialResult?.details?.results;
	if (!Array.isArray(results)) return;
	for (const record of results) {
		const messages = record?.messages;
		if (!Array.isArray(messages)) continue;
		stats.snapshotEmissions += 1;
		stats.updateMessagesBytes += Buffer.byteLength(JSON.stringify(messages), "utf8");
		const hash = createHash("sha256").update(JSON.stringify(messages)).digest("hex");
		stats.snapshotHashes.set(hash, (stats.snapshotHashes.get(hash) ?? 0) + 1);
	}
});

harness.setResponses([
	fauxAssistantMessage(fauxToolCall("subagent", { agent: "general", task: "inspect the repository" }), {
		stopReason: "toolUse",
	}),
	fauxAssistantMessage("parent done"),
]);

const startedAt = Date.now();
await harness.session.prompt("delegate the inspection");
await writeChain;
await new Promise<void>((resolve) => out.end(resolve));
clearInterval(sampler);
peakRss = Math.max(peakRss, process.memoryUsage().rss);

const size = statSync(logPath).size;
const mib = (n: number): number => +(n / 1024 / 1024).toFixed(2);
const distinct = stats.snapshotHashes.size;
const redundant = stats.snapshotEmissions - distinct;

console.log(
	JSON.stringify(
		{
			config: {
				childTurns: Number(process.env.REPRO_TURNS ?? 20),
				deltasPerTurn: Number(process.env.REPRO_DELTAS ?? 60),
				childToolBytes: Number(process.env.REPRO_TOOL_BYTES ?? 20_000),
			},
			logMiB: mib(size),
			toolExecutionUpdateEvents: stats.updates,
			updatePayloadMiB: mib(stats.updatePayloadBytes),
			payloadShareOfLogPct: +((stats.updatePayloadBytes / Math.max(1, size)) * 100).toFixed(1),
			bytesCarriedByMessagesMiB: mib(stats.updateMessagesBytes),
			largestUpdateMiB: mib(stats.largestUpdate),
			finalResultMiB: mib(stats.finalResultBytes),
			finalResultMessages: stats.finalResultMessages,
			distinctMessageSnapshots: distinct,
			snapshotEmissions: stats.snapshotEmissions,
			redundantSnapshotEmissions: redundant,
			peakRssMiB: mib(peakRss),
			elapsedMs: Date.now() - startedAt,
			eventsByType: Object.fromEntries([...stats.byType.entries()].sort((a, b) => b[1] - a[1])),
			mibByType: Object.fromEntries(
				[...stats.bytesByType.entries()]
					.sort((a, b) => b[1] - a[1])
					.map(([type, bytes]) => [type, mib(bytes)]),
			),
		},
		null,
		2,
	),
);

harness.cleanup();
rmSync(workDir, { recursive: true, force: true });
