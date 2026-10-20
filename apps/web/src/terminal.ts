import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanExitedWindowsShell, posixProcessTable, posixTerminalProcesses } from "./terminal-cleanup.ts";
import { type TerminalSupport, terminalSupport } from "./terminal-native.ts";
import { TerminalError, terminalEnvironment, terminalInput, terminalShell, terminalSize } from "./terminal-policy.ts";

export interface TerminalInfo {
	id: string;
	cwd: string;
	/** Workspace folder name, numbered when the folder already has a terminal. */
	title: string;
	/** Shell program name, e.g. `zsh` or `PowerShell`. */
	shell: string;
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
	/** Controlling pty name reported by the helper; valid only while the helper keeps the pty open. */
	tty?: string;
	chunks: TerminalChunk[];
	bytes: number;
	seq: number;
	listeners: Set<() => void>;
	closing?: Promise<void>;
	startedAt: number;
	startup: Promise<void>;
	exitedAt?: number;
	cleanup?: Promise<void>;
	pending: Map<string, { resolve: () => void; reject: (error: Error) => void }>;
};

/** Retains only a bounded output tail; no transcript or terminal data is written to disk. */
export class WebTerminals {
	private readonly entries = new Map<string, Entry>();
	private stopping = false;

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
	/** Native availability is rechecked on each call so a repaired install works without a Host restart. */
	support(): Promise<TerminalSupport> {
		return terminalSupport();
	}
	private title(cwd: string): string {
		const name = basename(cwd) || cwd;
		const used = new Set(this.list(cwd).map((info) => info.title));
		if (!used.has(name)) return name;
		let number = 2;
		while (used.has(`${name} ${number}`)) number++;
		return `${name} ${number}`;
	}
	async create(cwd: string, cols: unknown = 80, rows: unknown = 24): Promise<TerminalSnapshot> {
		if (this.stopping) throw new TerminalError("Terminals are shutting down", 503);
		if (this.entries.size >= 24 || this.list(cwd).length >= 8) throw new TerminalError("Terminal limit reached", 409);
		const size = terminalSize(cols, rows);
		const support = await this.support();
		if (!support.available) throw new TerminalError(support.reason, 503);
		if (this.stopping) throw new TerminalError("Terminals are shutting down", 503);
		if (this.entries.size >= 24 || this.list(cwd).length >= 8) throw new TerminalError("Terminal limit reached", 409);
		const worker = new URL(`./terminal-process${extname(fileURLToPath(import.meta.url))}`, import.meta.url);
		const loaders = worker.pathname.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : [];
		const startedAt = Date.now();
		let finishStartup = () => {};
		const startup = new Promise<void>((resolve) => {
			finishStartup = resolve;
		});
		const child = spawn(process.execPath, [...loaders, fileURLToPath(worker)], {
			cwd,
			// Desktop's Host is the Electron binary in Node mode; the helper needs the same mode.
			env: process.versions.electron
				? { ...terminalEnvironment(process.env), ELECTRON_RUN_AS_NODE: "1" }
				: terminalEnvironment(process.env),
			// POSIX: a separate process group keeps a Ctrl+C aimed at the Host's console from killing the
			// helper before the Host has cleaned up the shell it owns. Windows needs no console of its own.
			detached: process.platform !== "win32",
			windowsHide: true,
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		const entry: Entry = {
			info: {
				id: randomUUID(),
				cwd,
				title: this.title(cwd),
				shell: terminalShell().title,
				status: "starting",
				...size,
			},
			child,
			startedAt,
			startup,
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
				finishStartup();
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
				if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
				const message = raw as Record<string, unknown>;
				if (
					message.type === "ready" &&
					typeof message.pid === "number" &&
					Number.isSafeInteger(message.pid) &&
					message.pid > 0
				) {
					entry.info.pid = message.pid;
					if (typeof message.tty === "string" && /^[\w./-]{1,64}$/.test(message.tty)) entry.tty = message.tty;
					finishStartup();
					if (entry.closing) {
						if (!settled) {
							settled = true;
							clearTimeout(timer);
							reject(new TerminalError("Terminal closed during startup", 409));
						}
						return;
					}
					entry.info.status = "running";
					this.publish(entry);
					if (!settled) {
						settled = true;
						clearTimeout(timer);
						resolve(this.snapshot(entry.info.id));
					}
				} else if (entry.closing) return;
				else if (
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
					entry.exitedAt = Date.now();
					entry.info.status = "exited";
					entry.info.exitCode = message.exitCode;
					// The Host takes over cleanup while the helper still has an owner,
					// including descendants whose shell parent is already gone.
					entry.cleanup = this.terminate(entry);
					void entry.cleanup.catch((error: unknown) => {
						entry.cleanup = undefined;
						fail(error instanceof Error ? error.message : String(error));
					});
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
				finishStartup();
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
				// Keep the first specific failure (for example a native spawn error) visible.
				if (!entry.closing && entry.info.status !== "exited" && entry.info.status !== "failed")
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
		entry.closing = (entry.cleanup ?? this.terminate(entry))
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
		// Wait until startup either supplies the shell identity or fails. Killing
		// the helper while node-pty is spawning can miss a newly created child.
		await entry.startup;
		for (const pending of entry.pending.values()) pending.reject(new TerminalError("Terminal closed", 409));
		entry.pending.clear();
		await this.terminateHelper(entry);
		if (process.platform === "win32" && entry.info.pid)
			await cleanExitedWindowsShell(entry.info.pid, entry.startedAt, entry.exitedAt ?? Date.now());
	}
	/**
	 * Stops the shell and every process it owns. Enumeration and permission failures are not fatal:
	 * the shell's process group is still signalled, and closing the pty (the helper exits next) hangs
	 * up the remaining foreground jobs, including another user's processes such as `sudo`.
	 */
	private async stopPosixShell(entry: Entry, helperAlive: boolean): Promise<void> {
		const shell = entry.info.pid;
		if (!shell) return;
		// Without a live helper the shell PID may already belong to an unrelated process.
		const running = helperAlive && entry.exitedAt === undefined;
		let owned: number[] = [];
		try {
			owned = posixTerminalProcesses(
				await posixProcessTable(),
				{ pid: shell, running, tty: helperAlive ? entry.tty : undefined },
				new Set([process.pid, entry.child.pid ?? 0]),
			);
		} catch {
			// Best effort: see the method comment for what still stops the shell.
		}
		const kill = (pid: number) => {
			try {
				process.kill(pid, "SIGKILL");
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ESRCH" && code !== "EPERM") throw error;
			}
		};
		for (const pid of owned) kill(pid);
		if (running) {
			kill(-shell);
			kill(shell);
		}
	}
	private async terminateHelper(entry: Entry): Promise<void> {
		const child = entry.child;
		const helperAlive = child.exitCode === null && child.signalCode === null && Boolean(child.pid);
		if (process.platform !== "win32") await this.stopPosixShell(entry, helperAlive);
		if (!helperAlive) return;
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
		} else child.kill("SIGKILL");
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
