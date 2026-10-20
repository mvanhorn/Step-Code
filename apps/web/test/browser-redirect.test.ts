import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebBrowser } from "../src/browser.ts";

test("installed Chromium blocks redirected navigation, subresources and popups before contacting host ports", {
	skip: process.env.STEPCODE_WEB_BROWSER_TEST !== "1",
	timeout: 45_000,
}, async () => {
	let blockedRequests = 0;
	const seen = new Set<string>();
	const forbidden = createServer((_request, response) => {
		blockedRequests++;
		response.end("<title>Forbidden</title>");
	});
	forbidden.listen(0, "127.0.0.1");
	await once(forbidden, "listening");
	const blocked = forbidden.address();
	assert.ok(blocked && typeof blocked !== "string");
	const fixture = createServer((request, response) => {
		const path = request.url ?? "/";
		seen.add(path);
		if (path === "/worker.js") {
			response.setHeader("content-type", "text/javascript");
			response.end("fetch('/hop/worker').catch(() => {});");
			return;
		} else if (path.startsWith("/hop/")) {
			response.writeHead(302, { location: `/redirect/${path.slice(5)}` });
		} else if (path.startsWith("/redirect/")) {
			response.writeHead(307, { location: `http://127.0.0.1:${blocked.port}/private` });
		} else if (path === "/allowed-redirect") {
			response.writeHead(302, { location: "/allowed" });
		} else {
			response.setHeader("content-type", "text/html");
			response.end(`<title>Allowed</title>
				<img src="/hop/image"><iframe src="/hop/frame"></iframe>
				<script>fetch('/hop/fetch').catch(() => {}); new Worker('/worker.js');</script>
				<a style="position:fixed;left:0;top:0;width:200px;height:60px" target="_blank" href="/hop/popup">Popup</a>`);
			return;
		}
		response.end();
	});
	fixture.listen(0, "127.0.0.1");
	await once(fixture, "listening");
	const address = fixture.address();
	assert.ok(address && typeof address !== "string");
	const root = `http://127.0.0.1:${address.port}`;
	const browser = new WebBrowser([blocked.port]);
	const waitFor = async (predicate: () => boolean) => {
		for (let n = 0; n < 200; n++) {
			if (predicate()) return;
			await delay(50);
		}
		assert.fail(`Redirect fixture timed out: ${JSON.stringify(browser.snapshot())}`);
	};
	try {
		await browser.create(`${root}/hop/navigation`);
		await waitFor(() => seen.has("/redirect/navigation") && !browser.snapshot().tabs[0]?.loading);
		assert.ok(seen.has("/redirect/navigation"));
		assert.equal(blockedRequests, 0);
		const id = browser.snapshot().activeId;
		assert.ok(id);
		await browser.action(id, "navigate", `${root}/allowed-redirect`);
		await waitFor(() => browser.snapshot().tabs[0]?.title === "Allowed");
		await waitFor(() => ["image", "frame", "fetch", "worker"].every((kind) => seen.has(`/redirect/${kind}`)));
		await browser.input(id, { kind: "pointer", phase: "down", x: 30, y: 30, button: "left", clicks: 1 });
		await browser.input(id, { kind: "pointer", phase: "up", x: 30, y: 30, button: "left", clicks: 1 });
		await waitFor(() => seen.has("/redirect/popup") && browser.snapshot().tabs.length === 2);
		await waitFor(() => browser.snapshot().tabs.some((tab) => tab.id !== id && !tab.loading && tab.url !== "about:blank"));
		await delay(200);
		assert.equal(blockedRequests, 0, "A redirect reached the protected server");
	} finally {
		await browser.close();
		fixture.closeAllConnections();
		forbidden.closeAllConnections();
		await Promise.all([
			new Promise<void>((resolve) => fixture.close(() => resolve())),
			new Promise<void>((resolve) => forbidden.close(() => resolve())),
		]);
	}
});
