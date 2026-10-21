import { randomBytes } from "node:crypto";
import { createServer, type OutgoingHttpHeaders, request as requestHttp } from "node:http";
import { connect, type Socket } from "node:net";
import { browserUrl } from "./browser-policy.ts";

/** Every network destination, including redirects, workers and popup startup,
 * crosses this private proxy before Chromium can contact a protected port. */
export async function browserProxy(hostPorts: readonly number[]): Promise<{
	server: string;
	bypass: string;
	username: string;
	password: string;
	close: () => Promise<void>;
}> {
	const username = randomBytes(16).toString("hex");
	const password = randomBytes(32).toString("hex");
	const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
	const sockets = new Set<Socket>();
	const ports = [...hostPorts];
	let closing = false;
	let stopped: Promise<void> | undefined;
	const track = (socket: Socket) => {
		if (closing) socket.destroy();
		else {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
		}
	};
	const server = createServer((request, response) => {
		if (request.headers["proxy-authorization"] !== authorization) {
			response.writeHead(407, { "proxy-authenticate": 'Basic realm="StepCode browser"' }).end();
			return;
		}
		let target: URL;
		try {
			target = new URL(browserUrl(request.url, ports));
			if (target.protocol !== "http:") throw new Error("HTTPS requires CONNECT");
		} catch {
			response.writeHead(403).end("Browser destination blocked");
			return;
		}
		const headers: OutgoingHttpHeaders = { ...request.headers, host: target.host };
		delete headers["proxy-authorization"];
		delete headers["proxy-connection"];
		const upstream = requestHttp(target, { method: request.method, headers, agent: false }, (incoming) => {
			response.writeHead(incoming.statusCode ?? 502, incoming.headers);
			incoming.pipe(response);
			incoming.on("error", () => response.destroy());
		});
		upstream.on("socket", track);
		upstream.on("error", () => {
			if (!response.headersSent) response.writeHead(502).end();
			else response.destroy();
		});
		request.on("aborted", () => upstream.destroy());
		response.on("close", () => upstream.destroy());
		request.pipe(upstream);
	});
	server.on("connection", track);
	server.on("connect", (request, client, head) => {
		// Node drops the server's socket error listener for CONNECT and upgrades; a reset after a
		// refusal below would otherwise be an unhandled 'error' that takes the Host down.
		client.on("error", () => client.destroy());
		if (request.headers["proxy-authorization"] !== authorization) {
			client.end(
				'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="StepCode browser"\r\nConnection: close\r\n\r\n',
			);
			return;
		}
		let target: URL;
		try {
			target = new URL(browserUrl(`https://${request.url}`, ports));
			if (target.pathname !== "/" || target.search || target.hash) throw new Error("Invalid tunnel authority");
		} catch {
			client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			return;
		}
		const upstream = connect(Number(target.port || 443), target.hostname.replace(/^\[|\]$/g, ""));
		track(upstream);
		upstream.setTimeout(20_000, () => upstream.destroy());
		upstream.once("connect", () => {
			upstream.setTimeout(0);
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length) upstream.write(head);
			client.pipe(upstream).pipe(client);
		});
		upstream.on("error", () => client.destroy());
		client.on("error", () => upstream.destroy());
		client.on("close", () => upstream.destroy());
		upstream.on("close", () => client.destroy());
	});
	// WebSocket handshakes use an HTTP upgrade rather than CONNECT for ws://.
	server.on("upgrade", (request, client, head) => {
		client.on("error", () => client.destroy());
		if (request.headers["proxy-authorization"] !== authorization) {
			client.end(
				'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="StepCode browser"\r\nConnection: close\r\n\r\n',
			);
			return;
		}
		let target: URL;
		try {
			target = new URL(browserUrl(request.url?.replace(/^ws:/, "http:"), ports));
			if (target.protocol !== "http:") throw new Error("Invalid upgrade protocol");
		} catch {
			client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			return;
		}
		const headers: OutgoingHttpHeaders = { ...request.headers, host: target.host };
		delete headers["proxy-authorization"];
		delete headers["proxy-connection"];
		const upstream = requestHttp(target, { method: request.method, headers, agent: false });
		upstream.on("socket", track);
		upstream.on("upgrade", (response, socket, incomingHead) => {
			client.write(
				`HTTP/1.1 101 Switching Protocols\r\n${response.rawHeaders
					.map((value, index) => (index % 2 === 0 ? `${value}: ` : `${value}\r\n`))
					.join("")}\r\n`,
			);
			if (incomingHead.length) client.write(incomingHead);
			if (head.length) socket.write(head);
			client.pipe(socket).pipe(client);
			client.on("close", () => socket.destroy());
			socket.on("close", () => client.destroy());
			socket.on("error", () => client.destroy());
		});
		upstream.on("response", () => {
			upstream.destroy();
			client.destroy();
		});
		upstream.on("error", () => client.destroy());
		// A page that gives up before the upstream answers must not leave the handshake open.
		client.on("close", () => upstream.destroy());
		upstream.end();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Browser proxy did not bind");
	ports.push(address.port);
	return {
		server: `http://127.0.0.1:${address.port}`,
		// Chromium otherwise bypasses proxies for loopback destinations.
		bypass: "<-loopback>",
		username,
		password,
		close: () => {
			if (stopped) return stopped;
			closing = true;
			for (const socket of sockets) socket.destroy();
			stopped = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			return stopped;
		},
	};
}
