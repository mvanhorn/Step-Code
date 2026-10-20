import { api } from "../../lib/api";
import { setUi } from "../../state/store";
import type { TerminalInfo, TerminalSnapshot, TerminalSupport } from "../../state/types";

const ROOT = "/api/v1/terminals";

/** Shows or hides the bottom dock. Hiding only disconnects streams; shells keep running. */
export function toggleTerminalDock(open?: boolean): void {
	setUi((ui) => ({ terminalOpen: open ?? !ui.terminalOpen }));
}
/** Windows path spelling may differ from realpath; POSIX folder case is significant. */
export function terminalWorkspaceKey(value: string): string {
	if (/^[a-z]:[/\\]/i.test(value) || value.startsWith("\\\\"))
		return value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
	return value.replace(/\/+$/, "") || value;
}
export function listTerminals(
	cwd: string,
	signal?: AbortSignal,
): Promise<{ readonly terminals: readonly TerminalInfo[]; readonly support: TerminalSupport }> {
	return api(`${ROOT}?${new URLSearchParams({ cwd })}`, { signal });
}
export function createTerminal(cwd: string, size?: { cols: number; rows: number }): Promise<TerminalSnapshot> {
	return api<TerminalSnapshot>(ROOT, { method: "POST", body: JSON.stringify({ cwd, ...size }) });
}
export function closeTerminal(id: string): Promise<unknown> {
	return api(`${ROOT}/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Only the UI connection is disposable; it never owns the shell lifetime. */
export class TerminalConnection {
	private readonly controller = new AbortController();
	private readonly id: string;
	private cursor: number;
	private queue = Promise.resolve();
	private pending = 0;
	private readonly receive: (snapshot: TerminalSnapshot) => Promise<void>;
	private readonly status: (connected: boolean, error?: unknown) => void;
	private readonly closed: () => void;
	/** Consecutive failed attempts; reset by every delivered snapshot so long-lived tabs keep reconnecting. */
	private failures = 0;
	constructor(
		id: string,
		cursor: number,
		receive: (snapshot: TerminalSnapshot) => Promise<void>,
		status: (connected: boolean, error?: unknown) => void,
		closed: () => void,
	) {
		this.id = id;
		this.cursor = cursor;
		this.receive = receive;
		this.status = status;
		this.closed = closed;
	}
	async connect(): Promise<void> {
		while (!this.controller.signal.aborted) {
			try {
				await this.stream();
				return;
			} catch (error) {
				if (this.controller.signal.aborted) return;
				this.status(false, error);
				if (++this.failures >= 5) return;
				await new Promise<void>((resolve) => {
					const finish = () => {
						clearTimeout(timer);
						this.controller.signal.removeEventListener("abort", finish);
						resolve();
					};
					const timer = setTimeout(finish, Math.min(500 * 2 ** this.failures, 5000));
					this.controller.signal.addEventListener("abort", finish, { once: true });
				});
			}
		}
	}
	private async stream(): Promise<void> {
		const response = await fetch(`${ROOT}/${encodeURIComponent(this.id)}/events?after=${this.cursor}`, {
			signal: this.controller.signal,
		});
		if (!response.ok || !response.body) throw new Error(`Terminal stream HTTP ${response.status}`);
		const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
		let buffer = "";
		try {
			while (!this.controller.signal.aborted) {
				const { value, done } = await reader.read();
				if (done) throw new Error("Terminal stream disconnected");
				buffer += value;
				if (buffer.length > 4_000_000) throw new Error("Terminal event exceeds transport limit");
				let boundary = buffer.indexOf("\n\n");
				while (boundary >= 0) {
					const lines = buffer.slice(0, boundary).split("\n");
					buffer = buffer.slice(boundary + 2);
					const type = lines.find((line) => line.startsWith("event: "))?.slice(7);
					const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
					if (type === "closed") {
						this.closed();
						return;
					}
					if (type === "snapshot" && data) {
						const snapshot = JSON.parse(data) as TerminalSnapshot;
						await this.receive(snapshot);
						if (this.controller.signal.aborted) return;
						this.cursor = snapshot.seq;
						this.failures = 0;
						this.status(true);
					}
					boundary = buffer.indexOf("\n\n");
				}
			}
		} finally {
			await reader.cancel();
			reader.releaseLock();
		}
	}
	send(action: "input" | "resize", body: unknown): void {
		if (this.controller.signal.aborted) return;
		if (this.pending >= 64) {
			this.status(false, new Error("Terminal input queue is full"));
			this.close();
			return;
		}
		this.pending++;
		this.queue = this.queue
			.then(async () => {
				if (this.controller.signal.aborted) return;
				await api(`${ROOT}/${encodeURIComponent(this.id)}/${action}`, {
					method: "POST",
					body: JSON.stringify(body),
					signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(8000)]),
				});
			})
			.catch((error: unknown) => {
				// Input is never retried: a disconnected POST may already have executed.
				if (!this.controller.signal.aborted) {
					this.status(false, error);
					this.close();
				}
			})
			.finally(() => {
				this.pending--;
			});
	}
	close(): void {
		this.controller.abort();
	}
}
