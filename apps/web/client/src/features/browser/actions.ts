import { api } from "../../lib/api";
import type { EmbeddedBrowserFrame, EmbeddedBrowserSnapshot } from "../../state/types";

const ROOT = "/api/v1/browser";

/** One coalesced wheel command per frame; Chromium needs about two frames per dispatch. */
const WHEEL_FLUSH_MS = 40;
/** The host rejects a single wheel delta above this bound. */
const MAX_WHEEL_DELTA = 4000;

/** The parts of a keydown that decide where the key goes. */
export interface BrowserKeyEvent {
	readonly key: string;
	readonly altKey: boolean;
	readonly ctrlKey: boolean;
	readonly metaKey: boolean;
	readonly shiftKey: boolean;
	/** AltGr on Windows/Linux layouts (`getModifierState("AltGraph")`). */
	readonly altGraph: boolean;
}

/**
 * Where a keydown in the page's input goes: `copy` (the page selection), `native` (let the textarea
 * receive it, so its `input` event forwards the committed text), `ignore`, or a key press for the
 * host. A printed character is text even when AltGr or macOS Option produced it (`@` on a German
 * layout, `π` from Option+P); only Ctrl or Cmd turn a character into a shortcut. Windows reports
 * AltGr as Ctrl+Alt, so that pair is text too.
 */
export function browserKeyRoute(
	event: BrowserKeyEvent,
	mac: boolean,
): { kind: "copy" | "native" | "ignore" } | { kind: "key"; key: string; modifiers: number } {
	const altGr = event.altGraph || (!mac && event.ctrlKey && event.altKey);
	const mod = !altGr && (event.ctrlKey || event.metaKey);
	if (mod && event.key.toLowerCase() === "c") return { kind: "copy" };
	// Native paste/input supplies committed text, without touching the host browser clipboard.
	if (mod && event.key.toLowerCase() === "v") return { kind: "native" };
	if (!mod && event.key.length === 1 && (altGr || mac || !event.altKey)) return { kind: "native" };
	if (["Control", "Meta", "Alt", "AltGraph", "Shift", "Dead"].includes(event.key)) return { kind: "ignore" };
	return {
		kind: "key",
		key: event.key,
		modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0),
	};
}

/** Owns only this page's connection; tabs and browser lifetime belong to the host. */
export class BrowserConnection {
	private token = "";
	private controller = new AbortController();
	private heartbeat?: ReturnType<typeof setInterval>;
	private heartbeatMisses = 0;
	private queue: Promise<unknown> = Promise.resolve();
	private pending = 0;
	private revision = -1;
	private moved?: { path: string; body: unknown };
	private moveTimer?: ReturnType<typeof setTimeout>;
	private wheelPending?: { path: string; x: number; y: number; deltaX: number; deltaY: number };
	private wheelTimer?: ReturnType<typeof setTimeout>;
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
				.then((snapshot) => {
					this.heartbeatMisses = 0;
					this.acceptSnapshot(snapshot);
				})
				.catch((error: unknown) => {
					if (this.controller.signal.aborted) return;
					// A single slow or failed heartbeat is normal while the window sleeps or the Host
					// is busy; only a run of failures means this page lost its Host.
					if (++this.heartbeatMisses < 3) return;
					this.onError(error, true);
					this.close();
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
		this.flushWheel();
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

	/** Queue the accumulated wheel delta before a command that must observe its scroll position. */
	private flushWheel(): void {
		clearTimeout(this.wheelTimer);
		this.wheelTimer = undefined;
		const wheel = this.wheelPending;
		this.wheelPending = undefined;
		if (!wheel) return;
		this.send(wheel.path, {
			kind: "wheel",
			x: wheel.x,
			y: wheel.y,
			deltaX: wheel.deltaX,
			deltaY: wheel.deltaY,
		});
	}

	/**
	 * Coalesce wheel input like pointer movement. One request per event cannot keep up: Chromium
	 * needs about two frames per dispatch, so a 120 Hz trackpad fills the bounded queue and the
	 * dropped events lose scroll distance. Summing the deltas into one command per frame keeps
	 * that distance and leaves the queue to real input.
	 */
	wheel(path: string, body: { x: number; y: number; deltaX: number; deltaY: number }): void {
		if (!this.token || this.controller.signal.aborted) return;
		const current = this.wheelPending;
		if (
			current &&
			(current.path !== path ||
				Math.abs(current.deltaX + body.deltaX) > MAX_WHEEL_DELTA ||
				Math.abs(current.deltaY + body.deltaY) > MAX_WHEEL_DELTA)
		)
			this.flushWheel();
		const base = this.wheelPending;
		this.wheelPending = base
			? { ...base, x: body.x, y: body.y, deltaX: base.deltaX + body.deltaX, deltaY: base.deltaY + body.deltaY }
			: { path, x: body.x, y: body.y, deltaX: body.deltaX, deltaY: body.deltaY };
		if (!this.wheelTimer) this.wheelTimer = setTimeout(() => this.flushWheel(), WHEEL_FLUSH_MS);
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
			// On offline/navigation the host's lease expiry releases ownership once this page's
			// stream closes; an attached stream keeps it across a missed heartbeat.
		});
	}

	close(): void {
		clearInterval(this.heartbeat);
		clearTimeout(this.moveTimer);
		clearTimeout(this.wheelTimer);
		this.moved = undefined;
		this.wheelPending = undefined;
		this.controller.abort();
		this.release();
	}
}
