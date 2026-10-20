import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TerminalError, terminalEnvironment, terminalInput, terminalShell, terminalSize } from "./terminal-policy.ts";

export interface TerminalInfo {
	id: string;
	cwd: string;
	title: string;
	status: "starting" | "running" | "exited" | "failed";
	cols: number;
	rows: number;
	pid?: number;
	exitCode?: number;
	error?: string;
}
export interface TerminalChunk {
	seq: number;
	data: string;
}
export interface TerminalSnapshot {
	info: TerminalInfo;
	chunks: TerminalChunk[];
	seq: number;
	truncated: boolean;
}
type Entry = {
	info: TerminalInfo;
	child: ChildProcess;
	chunks: TerminalChunk[];
	bytes: number;
	seq: number;
	listeners: Set<() => void>;
	closing?: Promise<void>;
	pending: Map<string, { resolve: () => void; reject: (error: Error) => void }>;
};

/** Retains only a bounded output tail; no transcript or terminal data is written to disk. */
export class WebTerminals {
	private readonly entries = new Map<string, Entry>();
	private stopping = false;
	private number = 0;

	list(cwd: string): TerminalInfo[] {
		return [...this.entries.values()].filter((entry) => entry.info.cwd === cwd).map((entry) => ({ ...entry.info }));
	}
	private require(id: string): Entry {
		const entry = this.entries.get(id);
		if (!entry) throw new TerminalError("Unknown terminal", 404);
		return entry;
	}
	snapshot(id: string, after = 0): TerminalSnapshot {
		const entry = this.require(id);
		if (!Number.isSafeInteger(after) || after < 0 || after > entry.seq)
			throw new TerminalError("Invalid terminal cursor");
		return {
			info: { ...entry.info },
			seq: entry.seq,
			chunks: entry.chunks.filter((chunk) => chunk.seq > after),
			truncated: (entry.chunks[0]?.seq ?? 1) > after + 1,
		};
	}
	subscribe(id: string, listener: () => void): () => void {
		const entry = this.require(id);
		entry.listeners.add(listener);
		return () => entry.listeners.delete(listener);
	}
	private publish(entry: Entry): void {
		for (const listener of entry.listeners) listener();
	}
	async create(cwd: string, cols: unknown = 80, rows: unknown = 24): Promise<TerminalSnapshot> {
		if (this.stopping) throw new TerminalError("Terminals are shutting down", 503);
		if (this.entries.size >= 24 || this.list(cwd).length >= 8) throw new TerminalError("Terminal limit reached", 409);
		const size = terminalSize(cols, rows);
		const worker = new URL(`./terminal-process${extname(fileURLToPath(import.meta.url))}`, import.meta.url);
		const loaders = worker.pathname.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : [];
		const child = spawn(process.execPath, [...loaders, fileURLToPath(worker)], {
			cwd,
			env: terminalEnvironment(process.env),
			windowsHide: true,
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		const entry: Entry = {
			info: {
				id: randomUUID(),
				cwd,
				title: `${terminalShell().title} ${++this.number}`,
				status: "starting",
				...size,
			},
			child,
			chunks: [],
			bytes: 0,
			seq: 0,
			listeners: new Set(),
			pending: new Map(),
		};
		this.entries.set(entry.info.id, entry);
		// A missing native module must fail only this terminal, not the Web Host.
		let diagnostics = "";
		child.stderr?.on("data", (data: Buffer) => {
			diagnostics = (diagnostics + data.toString()).slice(-4096);
		});
		return new Promise((resolve, reject) => {
			let settled = false;
			const fail = (message: string) => {
				entry.info.status = "failed";
				entry.info.error = message;
				this.publish(entry);
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					reject(new TerminalError(message, 503));
				}
			};
			const timer = setTimeout(() => {
				fail("Terminal startup timed out");
				void this.close(entry.info.id).catch((error: unknown) => {
					entry.info.error = String(error);
					this.publish(entry);
				});
			}, 15000);
			child.on("message", (raw: unknown) => {
				if (!raw || typeof raw !== "object" || Array.isArray(raw) || entry.closing) return;
				const message = raw as Record<string, unknown>;
				if (
					message.type === "ready" &&
					typeof message.pid === "number" &&
					Number.isSafeInteger(message.pid) &&
					message.pid > 0
				) {
					entry.info.pid = message.pid;
					entry.info.status = "running";
					this.publish(entry);
					if (!settled) {
						settled = true;
						clearTimeout(timer);
						resolve(this.snapshot(entry.info.id));
					}
				} else if (
					message.type === "data" &&
					typeof message.seq === "number" &&
					message.seq === entry.seq + 1 &&
					typeof message.data === "string" &&
					message.data.length <= 8192
				) {
					entry.seq = message.seq;
					entry.chunks.push({ seq: message.seq, data: message.data });
					entry.bytes += Buffer.byteLength(message.data);
					while (entry.chunks.length > 1 && (entry.bytes > 524288 || entry.chunks.length > 2048)) {
						const removed = entry.chunks.shift();
						if (removed) entry.bytes -= Buffer.byteLength(removed.data);
					}
					this.publish(entry);
					child.send({ type: "ack", seq: entry.seq }, () => {
						/* Exit may race the final output acknowledgement. */
					});
				} else if (message.type === "exit" && typeof message.exitCode === "number") {
					entry.info.status = "exited";
					entry.info.exitCode = message.exitCode;
					this.publish(entry);
				} else if (typeof message.requestId === "string") {
					const pending = entry.pending.get(message.requestId);
					entry.pending.delete(message.requestId);
					if (message.type === "applied") pending?.resolve();
					else
						pending?.reject(
							new TerminalError(
								typeof message.message === "string" ? message.message : "Terminal command failed",
								503,
							),
						);
				} else if (message.type === "failed")
					fail(typeof message.message === "string" ? message.message : "Terminal startup failed");
			});
			child.once("error", (error) => fail(`Terminal helper failed: ${error.message}`));
			child.once("exit", () => {
				clearTimeout(timer);
				if (!settled) {
					settled = true;
					reject(
						new TerminalError(
							"Terminal helper exited before startup completed. Check the shell and node-pty installation.",
							503,
						),
					);
				}
				for (const pending of entry.pending.values()) pending.reject(new TerminalError("Terminal exited", 409));
				entry.pending.clear();
				if (!entry.closing && entry.info.status !== "exited")
					fail(
						diagnostics.includes("native module")
							? "Terminal native module unavailable. Check the node-pty installation for this platform."
							: "Terminal helper exited unexpectedly",
					);
			});
			child.send({ type: "start", cwd, ...size }, (error) => {
				if (error) fail(error.message);
			});
		});
	}
	private command(entry: Entry, value: Record<string, unknown>): Promise<void> {
		if (this.stopping || entry.closing || entry.info.status !== "running" || !entry.child.connected)
			throw new TerminalError("Terminal is not running", 409);
		if (entry.pending.size >= 32) throw new TerminalError("Terminal input queue is full", 429);
		const requestId = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				entry.pending.delete(requestId);
				reject(
					new TerminalError(
						"Terminal command timed out; its outcome is unknown. Do not automatically repeat it.",
						504,
					),
				);
			}, 5000);
			const finish = (error?: Error) => {
				clearTimeout(timer);
				entry.pending.delete(requestId);
				if (error) reject(error);
				else resolve();
			};
			entry.pending.set(requestId, { resolve: () => finish(), reject: finish });
			entry.child.send({ ...value, requestId }, (error) => {
				if (error) finish(error);
			});
		});
	}
	async write(id: string, data: unknown): Promise<void> {
		await this.command(this.require(id), { type: "write", data: terminalInput(data) });
	}
	async resize(id: string, cols: unknown, rows: unknown): Promise<void> {
		const entry = this.require(id);
		const size = terminalSize(cols, rows);
		await this.command(entry, { type: "resize", ...size });
		Object.assign(entry.info, size);
		this.publish(entry);
	}
	async close(id: string): Promise<void> {
		const entry = this.require(id);
		if (entry.closing) return entry.closing;
		entry.closing = this.terminate(entry)
			.then(() => {
				this.entries.delete(id);
				this.publish(entry);
				entry.listeners.clear();
			})
			.catch((error: unknown) => {
				entry.closing = undefined;
				entry.info.status = "failed";
				entry.info.error = error instanceof Error ? error.message : String(error);
				this.publish(entry);
				throw error;
			});
		return entry.closing;
	}
	private async terminate(entry: Entry): Promise<void> {
		const child = entry.child;
		if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
		for (const pending of entry.pending.values()) pending.reject(new TerminalError("Terminal closed", 409));
		entry.pending.clear();
		const stopped = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				child.off("exit", onExit);
				reject(new Error("Terminal helper did not exit after cleanup"));
			}, 6000);
			const onExit = () => {
				clearTimeout(timer);
				resolve();
			};
			child.once("exit", onExit);
		});
		// Observe immediately so failures during process-tree termination cannot leave a rejected promise unhandled.
		const observed = stopped.then(
			() => undefined,
			(error: unknown) => error,
		);
		if (process.platform === "win32") {
			await new Promise<void>((resolve, reject) => {
				const killer = spawn(
					join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
					["/PID", String(child.pid), "/T", "/F"],
					{ windowsHide: true, stdio: "ignore" },
				);
				const timer = setTimeout(() => {
					killer.kill();
					reject(new Error("Terminal process-tree cleanup timed out"));
				}, 5000);
				killer.once("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
				killer.once("exit", (code) => {
					clearTimeout(timer);
					if (code === 0 || child.exitCode !== null) resolve();
					else reject(new Error("Could not terminate terminal process tree"));
				});
			});
		} else {
			// Interactive jobs can have their own process groups; enumerate descendants
			// before killing the shell so ordinary background jobs cannot be orphaned.
			const listing = await new Promise<string>((resolve, reject) => {
				execFile("/bin/ps", ["-eo", "pid=,ppid="], { timeout: 3000, maxBuffer: 1048576 }, (error, stdout) => {
					if (error) reject(error);
					else resolve(stdout);
				});
			});
			const processes = listing
				.trim()
				.split("\n")
				.map((line) => line.trim().split(/\s+/).map(Number));
			const owned = [child.pid];
			for (let index = 0; index < owned.length; index++) {
				for (const [pid, parent] of processes) {
					if (parent === owned[index] && Number.isSafeInteger(pid) && pid > 1 && !owned.includes(pid))
						owned.push(pid);
				}
			}
			for (const pid of owned.slice(1).reverse()) {
				try {
					process.kill(pid, "SIGKILL");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
			}
			if (entry.info.pid) {
				try {
					process.kill(-entry.info.pid, "SIGKILL");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
			}
			child.kill("SIGTERM");
		}
		const error = await observed;
		if (error) throw error;
	}
	async stopAll(): Promise<void> {
		this.stopping = true;
		const results = await Promise.allSettled([...this.entries.keys()].map((id) => this.close(id)));
		const failed = results.filter((result) => result.status === "rejected");
		if (failed.length)
			throw new AggregateError(
				failed.map((result) => result.reason),
				"Some terminals could not be stopped",
			);
	}
}
