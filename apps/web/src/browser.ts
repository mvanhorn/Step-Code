import { randomUUID } from "node:crypto";
import { type Browser, type BrowserContext, type CDPSession, chromium, type Page } from "playwright-core";
import { type BrowserInput, BrowserRequestError, browserExecutable, browserUrl } from "./browser-policy.ts";
import { browserProxy } from "./browser-proxy.ts";

export interface BrowserTab {
	id: string;
	title: string;
	url: string;
	loading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	zoom: number;
	error?: string;
	notice?: "download" | "upload" | "dialog" | "popup" | "navigation";
}
export interface BrowserSnapshot {
	revision: number;
	activeId: string | null;
	tabs: BrowserTab[];
}
export interface BrowserFrame {
	tabId: string;
	width: number;
	height: number;
	data: string;
}
type BrowserEvent =
	| { type: "snapshot"; data: BrowserSnapshot }
	| { type: "frame"; data: BrowserFrame }
	| { type: "closed"; data: null };
interface OwnedTab {
	page: Page;
	cdp: CDPSession;
	view: BrowserTab;
	navigation: number;
	buttons: Set<"left" | "right" | "middle">;
}

/** Host-wide tabs, one leased controller, one bounded frame consumer. No personal profile. */
export class WebBrowser {
	private readonly hostPorts: readonly number[];
	private browser?: Browser;
	private proxy?: Awaited<ReturnType<typeof browserProxy>>;
	private context?: BrowserContext;
	private starting?: Promise<BrowserContext>;
	private disposed = false;
	private tabs = new Map<string, OwnedTab>();
	private activeId: string | null = null;
	private revision = 0;
	private lease?: { clientId: string; token: string; until: number };
	private consumer?: { token: string; send: (event: BrowserEvent) => void; close: () => void };
	private leaseTimer?: ReturnType<typeof setTimeout>;
	private streamQueue: Promise<void> = Promise.resolve();
	private commandQueue: Promise<unknown> = Promise.resolve();
	private pending = 0;
	private viewport = { width: 900, height: 700 };

	constructor(hostPorts: readonly number[]) {
		this.hostPorts = hostPorts;
	}

	snapshot(): BrowserSnapshot {
		return {
			revision: this.revision,
			activeId: this.activeId,
			tabs: [...this.tabs.values()].map(({ view }) => ({ ...view })),
		};
	}

	acquire(clientId: unknown): { token: string } {
		if (this.disposed) throw new BrowserRequestError("Browser host is stopping", 503);
		if (typeof clientId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(clientId))
			throw new BrowserRequestError("Invalid browser client id");
		if (this.lease && this.lease.until > Date.now() && this.lease.clientId !== clientId)
			throw new BrowserRequestError("The browser is controlled by another StepCode page", 409);
		// Rotate tokens on reload: late cleanup from the previous page cannot release its replacement.
		if (this.lease) this.release(this.lease.token);
		else this.detachConsumer();
		const token = randomUUID();
		this.lease = { clientId, token, until: Date.now() + 15_000 };
		this.touch(token);
		return { token };
	}

	touch(token: string): void {
		if (this.disposed || !this.lease || this.lease.token !== token || this.lease.until <= Date.now())
			throw new BrowserRequestError("Browser control expired; reconnect", 409);
		this.lease.until = Date.now() + 15_000;
		clearTimeout(this.leaseTimer);
		this.leaseTimer = setTimeout(() => this.release(token), 15_001);
		this.leaseTimer.unref();
	}

	release(token: string): void {
		if (this.lease?.token !== token) return;
		this.lease = undefined;
		clearTimeout(this.leaseTimer);
		this.detachConsumer();
		const tab = this.activeId ? this.tabs.get(this.activeId) : undefined;
		this.commandQueue = this.commandQueue
			.then(() => this.releasePointer(tab))
			.catch((error: unknown) => {
				if (!this.disposed)
					console.error(
						"Embedded browser input release failed:",
						error instanceof Error ? error.message : String(error),
					);
			});
	}

	private async releasePointer(tab: OwnedTab | undefined): Promise<void> {
		if (!tab || tab.page.isClosed()) return;
		for (const button of tab.buttons) await tab.page.mouse.up({ button });
		tab.buttons.clear();
	}

	private publish(): void {
		if (this.disposed) return;
		this.revision++;
		this.consumer?.send({ type: "snapshot", data: this.snapshot() });
	}

	private detachConsumer(): void {
		const previous = this.consumer;
		this.consumer = undefined;
		previous?.close();
		this.scheduleStream();
	}

	subscribe(token: string, send: (event: BrowserEvent) => void, close: () => void): () => void {
		this.touch(token);
		this.detachConsumer();
		const consumer = { token, send, close };
		this.consumer = consumer;
		send({ type: "snapshot", data: this.snapshot() });
		this.scheduleStream();
		return () => {
			if (this.consumer === consumer) this.detachConsumer();
		};
	}

	private scheduleStream(): void {
		this.streamQueue = this.streamQueue
			.then(async () => {
				for (const [id, tab] of this.tabs) {
					await tab.cdp.send("Page.stopScreencast");
					if (!this.disposed && this.consumer && id === this.activeId) {
						await tab.cdp.send("Page.startScreencast", {
							format: "jpeg",
							quality: 75,
							maxWidth: 1600,
							maxHeight: 1200,
						});
					}
				}
			})
			.catch((error: unknown) => {
				// A tab can close between selection and CDP delivery. Live-tab failures remain visible.
				const tab = this.activeId ? this.tabs.get(this.activeId) : undefined;
				if (tab && !tab.page.isClosed()) {
					tab.view.error = error instanceof Error ? error.message : String(error);
					this.publish();
				}
			});
	}

	private async engine(): Promise<BrowserContext> {
		if (this.disposed) throw new BrowserRequestError("Browser host is stopping", 503);
		if (this.context) return this.context;
		if (!this.starting) {
			this.starting = (async () => {
				this.proxy = await browserProxy(this.hostPorts);
				const { server, bypass, username, password } = this.proxy;
				const browser = await chromium.launch({
					executablePath: browserExecutable(),
					headless: true,
					chromiumSandbox: true,
					timeout: 15_000,
					proxy: { server, bypass, username, password },
				});
				this.browser = browser;
				if (this.disposed) {
					await browser.close();
					throw new BrowserRequestError("Browser host is stopping", 503);
				}
				const context = await browser.newContext({
					viewport: this.viewport,
					acceptDownloads: false,
					serviceWorkers: "block",
					permissions: [],
				});
				context.setDefaultTimeout(5000);
				await context.route("**/*", async (route) => {
					try {
						browserUrl(route.request().url(), this.hostPorts, true);
					} catch {
						await route.abort("blockedbyclient");
						return;
					}
					await route.continue();
				});
				await context.routeWebSocket(/.*/, (socket) => {
					const url = new URL(socket.url());
					if (this.hostPorts.includes(Number(url.port || (url.protocol === "wss:" ? 443 : 80))))
						void socket.close({ code: 1008, reason: "StepCode host port blocked" });
					else socket.connectToServer();
				});
				context.on("page", (page) => {
					// Explicit creation is registered before its first navigation. Popups are registered separately.
					void page
						.opener()
						.then(async (opener) => {
							if (!opener) return;
							if (this.tabs.size >= 12 || this.disposed) {
								await page.close();
								return;
							}
							await this.attach(page);
						})
						.catch((error: unknown) => {
							if (!this.disposed)
								console.error(
									"Embedded browser popup failed:",
									error instanceof Error ? error.message : String(error),
								);
						});
				});
				browser.on("disconnected", () => {
					const proxy = this.proxy;
					this.proxy = undefined;
					void proxy
						?.close()
						.catch((error: unknown) => console.error("Browser proxy cleanup failed:", String(error)));
					this.tabs.clear();
					this.activeId = null;
					this.context = undefined;
					this.browser = undefined;
					this.publish();
				});
				this.context = context;
				return context;
			})()
				.catch(async (error: unknown) => {
					const proxy = this.proxy;
					await this.browser?.close();
					await proxy?.close();
					this.proxy = undefined;
					this.context = undefined;
					this.browser = undefined;
					throw error;
				})
				.finally(() => {
					this.starting = undefined;
				});
		}
		return this.starting;
	}

	private async attach(page: Page): Promise<OwnedTab> {
		const cdp = await page.context().newCDPSession(page);
		if (this.disposed || page.isClosed() || this.tabs.size >= 12) {
			await page.close();
			throw new BrowserRequestError("Browser tab limit reached", 409);
		}
		const id = randomUUID();
		const tab: OwnedTab = {
			page,
			cdp,
			navigation: 0,
			buttons: new Set(),
			view: { id, title: "", url: page.url(), loading: false, canGoBack: false, canGoForward: false, zoom: 1 },
		};
		this.tabs.set(id, tab);
		this.activeId = id;
		let lastFrameAt = 0;
		let pendingFrame: BrowserFrame | undefined;
		let frameTimer: ReturnType<typeof setTimeout> | undefined;
		const flushFrame = () => {
			frameTimer = undefined;
			if (!this.disposed && this.consumer && this.activeId === id && pendingFrame) {
				lastFrameAt = Date.now();
				this.consumer.send({ type: "frame", data: pendingFrame });
			}
			pendingFrame = undefined;
		};
		cdp.on("Page.screencastFrame", (event) => {
			// ACK even dropped frames; network backpressure must never block Chromium.
			void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {
				// Detached CDP sessions cannot retain frame buffers.
			});
			if (!this.disposed && this.consumer && this.activeId === id && event.data.length <= 2_800_000) {
				// Cap transport/decode work at 15 fps, including continuously animated websites.
				pendingFrame = {
					tabId: id,
					width: event.metadata.deviceWidth,
					height: event.metadata.deviceHeight,
					data: event.data,
				};
				if (Date.now() - lastFrameAt >= 66) {
					clearTimeout(frameTimer);
					flushFrame();
				} else if (!frameTimer) frameTimer = setTimeout(flushFrame, 66 - (Date.now() - lastFrameAt));
			}
		});
		const refresh = () => {
			void this.refresh(tab);
		};
		page.on("framenavigated", (frame) => {
			if (frame === page.mainFrame()) refresh();
		});
		page.on("domcontentloaded", refresh);
		page.on("load", () => {
			tab.view.loading = false;
			refresh();
		});
		page.on("requestfailed", (request) => {
			if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
				tab.view.loading = false;
				tab.view.error = request.failure()?.errorText;
				this.publish();
			}
		});
		let mainFrameId = (await cdp.send("Page.getFrameTree")).frameTree.frame.id;
		cdp.on("Page.frameNavigated", ({ frame }) => {
			if (!frame.parentId) mainFrameId = frame.id;
		});
		cdp.on("Page.frameStartedLoading", ({ frameId }) => {
			if (frameId === mainFrameId) {
				tab.view.loading = true;
				this.publish();
			}
		});
		cdp.on("Page.frameStoppedLoading", ({ frameId }) => {
			if (frameId === mainFrameId) {
				tab.view.loading = false;
				refresh();
			}
		});
		page.on("download", (download) => {
			void download.cancel().catch((error: unknown) => {
				if (!this.disposed && !page.isClosed()) {
					tab.view.error = error instanceof Error ? error.message : String(error);
					this.publish();
				}
			});
			tab.view.error = undefined;
			tab.view.loading = false;
			tab.view.notice = "download";
			this.publish();
		});
		page.on("filechooser", (chooser) => {
			void chooser.setFiles([]).catch(() => {
				// Navigation/closure can destroy the chooser; no host paths were supplied.
			});
			tab.view.notice = "upload";
			this.publish();
		});
		page.on("dialog", (dialog) => {
			void dialog.dismiss().catch(() => {
				// The originating document may have closed; dialogs never survive their page.
			});
			tab.view.notice = "dialog";
			this.publish();
		});
		page.on("close", () => {
			clearTimeout(frameTimer);
			this.tabs.delete(id);
			if (this.activeId === id) this.activeId = [...this.tabs.keys()].at(-1) ?? null;
			this.publish();
			this.scheduleStream();
		});
		await cdp.send("Page.enable");
		await page.bringToFront();
		await this.resizeTab(tab);
		await this.refresh(tab);
		this.publish();
		this.scheduleStream();
		return tab;
	}

	private async refresh(tab: OwnedTab): Promise<void> {
		try {
			const [title, history] = await Promise.all([tab.page.title(), tab.cdp.send("Page.getNavigationHistory")]);
			if (this.disposed || !this.tabs.has(tab.view.id)) return;
			tab.view.title = title.slice(0, 512);
			tab.view.url = tab.page.url();
			tab.view.canGoBack = history.currentIndex > 0;
			tab.view.canGoForward = history.currentIndex < history.entries.length - 1;
			this.publish();
		} catch (error) {
			if (!tab.page.isClosed() && !this.disposed) {
				tab.view.error = error instanceof Error ? error.message : String(error);
				this.publish();
			}
		}
	}

	private async resizeTab(tab: OwnedTab): Promise<void> {
		await tab.page.setViewportSize({
			width: Math.max(64, Math.round(this.viewport.width / tab.view.zoom)),
			height: Math.max(64, Math.round(this.viewport.height / tab.view.zoom)),
		});
	}

	/** Ordered mutations with a hard queue bound, checked again at execution time. */
	command<T>(token: string, operation: () => Promise<T>): Promise<T> {
		this.touch(token);
		if (this.pending >= 64) throw new BrowserRequestError("Browser input queue is full", 429);
		this.pending++;
		const next = this.commandQueue.then(() => {
			this.touch(token);
			return operation();
		});
		this.commandQueue = next
			// The caller observes `next`; only the queue tail consumes rejection so later work can continue.
			.catch(() => {})
			.finally(() => {
				this.pending--;
			});
		return next;
	}

	async create(url: unknown = "about:blank"): Promise<BrowserSnapshot> {
		const target = browserUrl(url, this.hostPorts, true);
		if (this.tabs.size >= 12) throw new BrowserRequestError("At most 12 browser tabs are allowed", 409);
		const context = await this.engine();
		const tab = await this.attach(await context.newPage());
		if (target !== "about:blank") this.navigate(tab, target);
		return this.snapshot();
	}

	private tab(id: string): OwnedTab {
		const tab = this.tabs.get(id);
		if (!tab) throw new BrowserRequestError("Browser tab not found", 404);
		return tab;
	}

	async select(id: string): Promise<void> {
		const tab = this.tab(id);
		await this.releasePointer(this.activeId ? this.tabs.get(this.activeId) : undefined);
		await tab.page.bringToFront();
		this.activeId = id;
		this.publish();
		this.scheduleStream();
	}

	async closeTab(id: string): Promise<void> {
		await this.tab(id).page.close();
	}

	async selection(id: string): Promise<string> {
		const result = await this.tab(id).cdp.send("Runtime.evaluate", {
			expression: `(() => {
				const element = document.activeElement;
				if (element && element.type === "password") return "";
				if (element && typeof element.selectionStart === "number")
					return element.value.slice(element.selectionStart, element.selectionEnd).slice(0, 65536);
				return String(window.getSelection() || "").slice(0, 65536);
			})()`,
			returnByValue: true,
		});
		return typeof result.result.value === "string" ? result.result.value : "";
	}

	private navigate(tab: OwnedTab, url: string): void {
		const navigation = ++tab.navigation;
		tab.view.error = undefined;
		tab.view.notice = undefined;
		tab.view.loading = true;
		this.publish();
		void tab.page
			.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 })
			.catch((error: unknown) => {
				if (this.tabs.has(tab.view.id) && navigation === tab.navigation && !this.disposed) {
					tab.view.error = error instanceof Error ? error.message : String(error);
				}
			})
			.finally(() => {
				if (this.tabs.has(tab.view.id) && navigation === tab.navigation && !this.disposed) {
					tab.view.loading = false;
					void this.refresh(tab);
				}
			});
	}

	async action(id: string, action: unknown, value?: unknown): Promise<void> {
		const tab = this.tab(id);
		if (action === "navigate") this.navigate(tab, browserUrl(value, this.hostPorts));
		else if (action === "stop") {
			++tab.navigation;
			await tab.cdp.send("Page.stopLoading");
			tab.view.loading = false;
		} else if (action === "reload") this.navigate(tab, browserUrl(tab.page.url(), this.hostPorts, true));
		else if (action === "back" || action === "forward") {
			const history = await tab.cdp.send("Page.getNavigationHistory");
			const entry = history.entries[history.currentIndex + (action === "back" ? -1 : 1)];
			if (entry) {
				browserUrl(entry.url, this.hostPorts, true);
				await tab.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id });
			}
		} else if (action === "zoom") {
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0.5 || value > 2)
				throw new BrowserRequestError("Zoom must be between 0.5 and 2");
			tab.view.zoom = Math.round(value * 10) / 10;
			await this.resizeTab(tab);
			this.scheduleStream();
		} else throw new BrowserRequestError("Unknown browser action");
		this.publish();
	}

	async resize(width: unknown, height: unknown): Promise<void> {
		if (
			typeof width !== "number" ||
			typeof height !== "number" ||
			!Number.isInteger(width) ||
			!Number.isInteger(height) ||
			width < 160 ||
			width > 1600 ||
			height < 120 ||
			height > 1200
		)
			throw new BrowserRequestError("Invalid browser viewport");
		this.viewport = { width, height };
		await Promise.all([...this.tabs.values()].map((tab) => this.resizeTab(tab)));
		this.scheduleStream();
	}

	async input(id: string, input: BrowserInput): Promise<void> {
		const tab = this.tab(id);
		if (id !== this.activeId) throw new BrowserRequestError("The browser tab is no longer active", 409);
		if (input.kind === "text") await tab.page.keyboard.insertText(input.text);
		else if (input.kind === "key") {
			const modifiers = [
				...(input.modifiers & 1 ? ["Alt"] : []),
				...(input.modifiers & 2 ? ["Control"] : []),
				...(input.modifiers & 4 ? ["Meta"] : []),
				...(input.modifiers & 8 ? ["Shift"] : []),
			];
			await tab.page.keyboard.press([...modifiers, input.key].join("+"));
		} else if (input.kind === "wheel") {
			await tab.page.mouse.move(input.x, input.y);
			await tab.page.mouse.wheel(input.deltaX, input.deltaY);
		} else {
			await tab.page.mouse.move(input.x, input.y);
			if (input.phase === "down") {
				await tab.page.mouse.down({ button: input.button, clickCount: input.clicks });
				tab.buttons.add(input.button);
			}
			if (input.phase === "up") {
				await tab.page.mouse.up({ button: input.button, clickCount: input.clicks });
				tab.buttons.delete(input.button);
			}
		}
	}

	async close(): Promise<void> {
		this.disposed = true;
		clearTimeout(this.leaseTimer);
		this.consumer?.send({ type: "closed", data: null });
		this.detachConsumer();
		try {
			await this.starting;
		} catch {
			/* Failed startup has already closed its owned browser. */
		}
		const proxy = this.proxy;
		await this.browser?.close();
		await proxy?.close();
		this.proxy = undefined;
		await Promise.allSettled([this.commandQueue, this.streamQueue]);
		this.tabs.clear();
		this.context = undefined;
		this.browser = undefined;
	}
}
