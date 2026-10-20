import { type IPty, spawn } from "node-pty";
import { terminalInput, terminalShell, terminalSize } from "./terminal-policy.ts";

let pty: IPty | undefined;
let outstanding = 0;
let sequence = 0;
const unacknowledged = new Map<number, number>();
let paused = false;

function send(value: unknown): void {
	if (process.connected) process.send?.(value);
}

process.on("message", (raw: unknown) => {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
	const message = raw as Record<string, unknown>;
	try {
		if (message.type === "start" && !pty) {
			if (typeof message.cwd !== "string") throw new Error("Invalid terminal directory");
			const size = terminalSize(message.cols, message.rows);
			const shell = terminalShell();
			pty = spawn(shell.file, shell.args, {
				...size,
				cwd: message.cwd,
				env: process.env,
				name: "xterm-256color",
				useConpty: true,
			});
			send({ type: "ready", pid: pty.pid, title: shell.title });
			pty.onData((data) => {
				// IPC output is acknowledged by the Host, independently of UI presence.
				for (let start = 0; start < data.length; start += 8192) {
					const value = data.slice(start, start + 8192);
					const seq = ++sequence;
					const bytes = Buffer.byteLength(value);
					unacknowledged.set(seq, bytes);
					outstanding += bytes;
					send({ type: "data", seq, data: value });
				}
				if (outstanding >= 262144 && !paused) {
					paused = true;
					pty?.pause();
				}
			});
			pty.onExit(({ exitCode }) => {
				send({ type: "exit", exitCode });
				// The Host owns descendant cleanup, including children whose shell
				// has exited. Keep IPC and the helper alive until cleanup finishes.
			});
		} else if (message.type === "ack" && typeof message.seq === "number") {
			for (const [seq, bytes] of unacknowledged) {
				if (seq > message.seq) break;
				outstanding -= bytes;
				unacknowledged.delete(seq);
			}
			if (paused && outstanding <= 65536) {
				paused = false;
				pty?.resume();
			}
		} else if (message.type === "write" && pty) {
			pty.write(terminalInput(message.data));
			send({ type: "applied", requestId: message.requestId });
		} else if (message.type === "resize" && pty) {
			const size = terminalSize(message.cols, message.rows);
			pty.resize(size.cols, size.rows);
			send({ type: "applied", requestId: message.requestId });
		} else if (message.type === "stop") pty?.kill();
	} catch (error) {
		send({
			type: "failed",
			message: error instanceof Error ? error.message : "Terminal operation failed",
			requestId: message.requestId,
		});
		if (!pty && process.connected) process.disconnect();
	}
});
process.on("disconnect", () => {
	try {
		pty?.kill();
	} finally {
		process.exit(0);
	}
});
