// Fake `step --mode rpc` child for the live-update regression tests.
//
// Speaks the real framing (one JSON object per LF-framed line) and streams what
// a long child produces: text deltas, persisted messages, tool progress. Only
// its token stream is synthetic; everything it drives on the parent side is the
// production rpc adapter, parser, orchestration, agent loop and json projection.
const TURNS = Number(process.env.STREAM_TURNS ?? 10);
const DELTAS = Number(process.env.STREAM_DELTAS ?? 40);
const TOOL_BYTES = Number(process.env.STREAM_TOOL_BYTES ?? 20_000);
const DELAY_MS = Number(process.env.STREAM_DELAY_MS ?? 0);
const FINAL_BYTES = Number(process.env.STREAM_FINAL_BYTES ?? 0);

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	const lines = buffer.split("\n");
	buffer = lines.pop() ?? "";
	for (const line of lines) void handle(line.trim());
});

const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

function write(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function assistant(content, stopReason = "stop") {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "step",
		model: "step-3.8-code-alpha",
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: {} },
		stopReason,
		timestamp: Date.now(),
	};
}

async function handle(line) {
	if (!line) return;
	let command;
	try {
		command = JSON.parse(line);
	} catch {
		return;
	}
	if (command.type === "get_state") {
		write({
			type: "response",
			id: command.id,
			command: "get_state",
			success: true,
			data: { sessionFile: "/tmp/stream-child-session.jsonl" },
		});
		return;
	}
	if (command.type === "abort") {
		write({ type: "agent_settled" });
		return;
	}
	if (command.type !== "prompt") return;

	write({ type: "response", id: command.id, command: "prompt", success: true });
	write({ type: "agent_start" });

	const messages = [];
	for (let turn = 0; turn < TURNS; turn++) {
		write({ type: "turn_start" });
		write({ type: "message_start", message: assistant([]) });
		let text = "";
		for (let index = 0; index < DELTAS; index++) {
			const delta = `token-${turn}-${index} `;
			text += delta;
			write({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
			await sleep(DELAY_MS);
		}
		const message = assistant([{ type: "text", text }], "toolUse");
		messages.push(message);
		write({ type: "message_end", message });

		const toolCallId = `call_${turn}`;
		const output = "x".repeat(TOOL_BYTES);
		write({ type: "tool_execution_start", toolCallId, toolName: "run_command", args: { command: `echo ${turn}` } });
		write({ type: "tool_execution_update", toolCallId, toolName: "run_command", partialResult: output });
		const result = {
			role: "toolResult",
			toolCallId,
			toolName: "run_command",
			content: [{ type: "text", text: output }],
			isError: false,
			timestamp: Date.now(),
		};
		messages.push(result);
		write({
			type: "tool_execution_end",
			toolCallId,
			toolName: "run_command",
			result: { content: [{ type: "text", text: output }] },
			isError: false,
		});
		write({ type: "message_end", message: result });
		write({ type: "turn_end" });
		await sleep(DELAY_MS);
	}

	const finalText = `child finished${FINAL_BYTES > 0 ? ` ${"y".repeat(FINAL_BYTES)}` : ""}`;
	write({ type: "message_end", message: assistant([{ type: "text", text: finalText }]) });
	write({ type: "agent_end" });
	write({ type: "agent_settled" });
}
