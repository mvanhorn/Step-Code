import { api } from "../../lib/api";
import type { EmbeddedBrowserFrame, EmbeddedBrowserSnapshot } from "../../state/types";

const ROOT = "/api/v1/browser";

/** Owns only this page's connection; tabs and browser lifetime belong to the host. */
export class BrowserConnection {
	private token = "";
	private controller = new AbortController();
	private heartbeat?: ReturnType<typeof setInterval>;
	private queue: Promise<unknown> = Promise.resolve();
	private pending = 0;
	private revision = -1;
	private moved?: { path: string; body: unknown };
	private moveTimer?: ReturnType<typeof setTimeout>;
	private readonly onSnapshot: (state: EmbeddedBrowserSnapshot) => void;
	private readonly onFrame: (frame: EmbeddedBrowserFrame) => void;
	private readonly onError: (error: unknown, disconnected: boolean) => void;

	constructor(
		onSnapshot: (state: EmbeddedBrowserSnapshot) => void,
		onFrame: (frame: EmbeddedBrowserFrame) => void,
		onError: (error: unknown, disconnected: boolean) => void,
	) {
		this.onSnapshot = onSnapshot;
		this.onFrame = onFrame;
		this.onError = onError;
	}

	private request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
		return api<T>(`${ROOT}${path}`, {
			method,
			body: body === undefined ? undefined : JSON.stringify(body),
			headers: { "x-stepcode-browser-control": this.token },
			signal: this.controller.signal,
		});
	}

	private acceptSnapshot(snapshot: EmbeddedBrowserSnapshot): void {
		if (
			this.controller.signal.aborted ||
			!Array.isArray(snapshot.tabs) ||
			!Number.isSafeInteger(snapshot.revision) ||
			snapshot.revision < 0 ||
			snapshot.revision <= this.revision
		)
			return;
		this.revision = snapshot.revision;
		this.onSnapshot(snapshot);
	}

	async connect(): Promise<void> {
		let clientId: string;
		try {
			clientId = sessionStorage.getItem("stepcode-browser-client") || crypto.randomUUID();
			sessionStorage.setItem("stepcode-browser-client", clientId);
		} catch {
			clientId = crypto.randomUUID();
		}
		const result = await this.request<{ token: string }>("/control", "POST", { clientId });
		this.token = result.token;
		if (this.controller.signal.aborted) {
			this.release();
			return;
		}
		this.acceptSnapshot(await this.request<EmbeddedBrowserSnapshot>(""));
		if (this.controller.signal.aborted) return;
		this.heartbeat = setInterval(() => {
			void this.request<EmbeddedBrowserSnapshot>("")
				.then((snapshot) => this.acceptSnapshot(snapshot))
				.catch((error: unknown) => {
					if (!this.controller.signal.aborted) {
						this.onError(error, true);
						this.close();
					}
				});
		}, 5000);
		void this.stream().catch((error: unknown) => {
			if (!this.controller.signal.aborted) {
				this.onError(error, true);
				this.close();
			}
		});
	}

	private async stream(): Promise<void> {
		const response = await fetch(`${ROOT}/events`, {
			headers: { "x-stepcode-browser-control": this.token },
			signal: this.controller.signal,
		});
		if (!response.ok || !response.body) throw new Error(`Browser stream HTTP ${response.status}`);
		const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
		let pending = "";
		try {
			while (!this.controller.signal.aborted) {
				const { value, done } = await reader.read();
				if (done) throw new Error("Browser stream disconnected");
				pending += value;
				if (pending.length > 4_000_000) throw new Error("Browser frame exceeds transport limit");
				let boundary = pending.indexOf("\n\n");
				while (boundary >= 0) {
					const event = pending.slice(0, boundary);
					pending = pending.slice(boundary + 2);
					const type = event
						.split("\n")
						.find((line) => line.startsWith("event: "))
						?.slice(7);
					const data = event
						.split("\n")
						.find((line) => line.startsWith("data: "))
						?.slice(6);
					if (data && type === "snapshot") this.acceptSnapshot(JSON.parse(data) as EmbeddedBrowserSnapshot);
					if (data && type === "frame") this.onFrame(JSON.parse(data) as EmbeddedBrowserFrame);
					if (type === "closed") throw new Error("Browser host stopped");
					boundary = pending.indexOf("\n\n");
				}
			}
		} finally {
			await reader.cancel();
			reader.releaseLock();
		}
	}

	send(path: string, body?: unknown, method = "POST"): void {
		if (!this.token || this.controller.signal.aborted) return;
		const moved = this.moved;
		this.moved = undefined;
		clearTimeout(this.moveTimer);
		this.moveTimer = undefined;
		if (moved) this.send(moved.path, moved.body);
		if (this.pending >= 48) {
			this.onError(new Error("Browser input queue is full"), false);
			return;
		}
		this.pending++;
		this.queue = this.queue
			.then(async () => {
				const snapshot = await this.request<EmbeddedBrowserSnapshot>(path, method, body);
				this.acceptSnapshot(snapshot);
			})
			.catch((error: unknown) => {
				if (!this.controller.signal.aborted) this.onError(error, false);
			})
			.finally(() => {
				this.pending--;
			});
	}

	move(path: string, body: unknown): void {
		this.moved = { path, body };
		if (this.moveTimer) return;
		this.moveTimer = setTimeout(() => {
			this.moveTimer = undefined;
			const moved = this.moved;
			this.moved = undefined;
			if (moved) this.send(moved.path, moved.body);
		}, 40);
	}

	async selection(id: string): Promise<string> {
		return (await this.request<{ text: string }>(`/tabs/${id}/selection`)).text;
	}

	private release(): void {
		if (!this.token) return;
		void fetch(`${ROOT}/control`, {
			method: "DELETE",
			headers: { "x-stepcode-browser-control": this.token },
			keepalive: true,
		}).catch(() => {
			// On offline/navigation the host's 15-second lease expiry releases ownership.
		});
	}

	close(): void {
		clearInterval(this.heartbeat);
		clearTimeout(this.moveTimer);
		this.controller.abort();
		this.release();
	}
}
