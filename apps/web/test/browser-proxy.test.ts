import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as requestHttp } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import { browserProxy } from "../src/browser-proxy.ts";

test("browser proxy authenticates, strips its secret, blocks HTTP and CONNECT ports, and drains tunnels", async () => {
	let forbiddenHits = 0;
	const forbidden = createServer((_request, response) => { forbiddenHits++; response.end("private"); });
	const target = createServer((request, response) => {
		assert.equal(request.headers["proxy-authorization"], undefined);
		response.end("allowed");
	});
	forbidden.listen(0, "127.0.0.1");
	target.listen(0, "127.0.0.1");
	await Promise.all([once(forbidden, "listening"), once(target, "listening")]);
	const blocked = forbidden.address();
	const allowed = target.address();
	assert.ok(blocked && typeof blocked !== "string");
	assert.ok(allowed && typeof allowed !== "string");
	const proxy = await browserProxy([blocked.port]);
	const address = new URL(proxy.server);
	const authorization = `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}`;
	const get = (url: string, authenticated: boolean) => new Promise<{ status: number; body: string }>((resolve, reject) => {
		const request = requestHttp({
			hostname: address.hostname, port: address.port, path: url,
			headers: authenticated ? { "proxy-authorization": authorization } : {},
		}, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => { body += chunk; });
			response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
		});
		request.on("error", reject);
		request.end();
	});
	try {
		assert.equal((await get(`http://127.0.0.1:${allowed.port}`, false)).status, 407);
		assert.deepEqual(await get(`http://127.0.0.1:${allowed.port}`, true), { status: 200, body: "allowed" });
		assert.equal((await get(`http://127.0.0.1:${blocked.port}`, true)).status, 403);
		assert.equal((await get(proxy.server, true)).status, 403);
		for (const port of [blocked.port, allowed.port]) {
			const request = requestHttp({
				hostname: address.hostname, port: address.port, method: "CONNECT",
				path: `127.0.0.1:${port}`, headers: { "proxy-authorization": authorization },
			});
			const connected = once(request, "connect");
			request.end();
			const [response, socket] = await connected;
			assert.equal(response.statusCode, port === blocked.port ? 403 : 200);
			if (port === allowed.port) {
				const closed = once(socket, "close");
				socket.resume();
				await proxy.close();
				await closed;
			} else socket.destroy();
		}
		assert.equal(forbiddenHits, 0);
		await assert.rejects(get(`http://127.0.0.1:${allowed.port}`, true));
	} finally {
		await proxy.close();
		forbidden.closeAllConnections();
		target.closeAllConnections();
		await Promise.all([
			new Promise<void>((resolve) => forbidden.close(() => resolve())),
			new Promise<void>((resolve) => target.close(() => resolve())),
		]);
	}
});

test("browser proxy survives clients that reset while a CONNECT or upgrade is refused", async () => {
	const proxy = await browserProxy([]);
	const address = new URL(proxy.server);
	const crashes: unknown[] = [];
	const onCrash = (error: unknown) => crashes.push(error);
	process.on("uncaughtException", onCrash);
	try {
		for (let round = 0; round < 20; round++) {
			for (const head of [
				"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
				"GET ws://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
			]) {
				const socket = connect(Number(address.port), address.hostname);
				socket.on("error", () => {});
				await once(socket, "connect");
				socket.write(head);
				socket.resetAndDestroy();
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.deepEqual(crashes, []);
		// Still serving: an unauthenticated request is refused, not dropped.
		const status = await new Promise<number>((resolve, reject) => {
			const request = requestHttp({ hostname: address.hostname, port: address.port, path: "http://example.com/" }, (response) => {
				response.resume();
				resolve(response.statusCode ?? 0);
			});
			request.on("error", reject);
			request.end();
		});
		assert.equal(status, 407);
	} finally {
		process.off("uncaughtException", onCrash);
		await proxy.close();
	}
});
