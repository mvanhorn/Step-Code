import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebTerminals } from "./terminal.ts";
import { TerminalError } from "./terminal-policy.ts";

function reply(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(value));
}
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		bytes += buffer.length;
		if (bytes > 131072) throw new TerminalError("Terminal request exceeds 128 KiB", 413);
		chunks.push(buffer);
	}
	let value: unknown;
	try {
		value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
	} catch {
		throw new TerminalError("Invalid terminal JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new TerminalError("Terminal body must be an object");
	return value as Record<string, unknown>;
}

/** The caller must perform the Host's cookie and Origin checks before dispatch. */
export async function terminalRoute(
	terminals: WebTerminals,
	parts: string[],
	url: URL,
	request: IncomingMessage,
	response: ServerResponse,
	knownWorkspace: (input: string | null) => Promise<string | undefined>,
): Promise<void> {
	try {
		const method = request.method || "GET";
		if (parts.length === 0 && (method === "GET" || method === "POST")) {
			const input = method === "POST" ? await readBody(request) : {};
			const cwd = await knownWorkspace(
				method === "GET" ? url.searchParams.get("cwd") : typeof input.cwd === "string" ? input.cwd : null,
			);
			if (!cwd) throw new TerminalError("Folder is not a known workspace", 403);
			if (method === "GET") return reply(response, 200, { terminals: terminals.list(cwd) });
			return reply(response, 201, await terminals.create(cwd, input.cols, input.rows));
		}
		const id = parts[0];
		if (!id) throw new TerminalError("Unknown terminal route", 404);
		if (parts.length === 1 && method === "DELETE") {
			await terminals.close(id);
			return reply(response, 200, { ok: true });
		}
		if (parts.length === 2 && method === "POST" && (parts[1] === "input" || parts[1] === "resize")) {
			const input = await readBody(request);
			if (parts[1] === "input") await terminals.write(id, input.data);
			else await terminals.resize(id, input.cols, input.rows);
			return reply(response, 200, { ok: true });
		}
		if (parts.length === 2 && method === "GET" && parts[1] === "events") {
			let cursor = Number(url.searchParams.get("after") || "0");
			terminals.snapshot(id, cursor);
			response.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-store",
				connection: "keep-alive",
				"x-accel-buffering": "no",
			});
			let scheduled: ReturnType<typeof setTimeout> | undefined;
			let blockedAt = 0;
			const flush = () => {
				scheduled = undefined;
				if (response.destroyed || response.writableEnded) return;
				if (response.writableNeedDrain) {
					blockedAt ||= Date.now();
					return;
				}
				blockedAt = 0;
				try {
					const snapshot = terminals.snapshot(id, cursor);
					cursor = snapshot.seq;
					response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
				} catch {
					response.end("event: closed\ndata: {}\n\n");
				}
			};
			const schedule = () => {
				scheduled ??= setTimeout(flush, 16);
			};
			const unsubscribe = terminals.subscribe(id, schedule);
			response.on("drain", schedule);
			const heartbeat = setInterval(() => {
				if (response.writableNeedDrain) {
					blockedAt ||= Date.now();
					if (Date.now() - blockedAt > 10000) response.destroy();
				} else response.write(": heartbeat\n\n");
			}, 2000);
			response.once("close", () => {
				clearInterval(heartbeat);
				clearTimeout(scheduled);
				response.off("drain", schedule);
				unsubscribe();
			});
			flush();
			return;
		}
		throw new TerminalError("Unknown terminal route", 404);
	} catch (error) {
		if (response.headersSent) {
			response.end();
			return;
		}
		reply(response, error instanceof TerminalError ? error.status : 503, {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
