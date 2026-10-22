/**
 * One person, one room bot.
 *
 * `/room` must reach for the same application on every run. These tests pin the three outcomes of
 * that lookup: a working saved bot is reused without asking anyone, dead credentials are replaced,
 * and a platform that cannot be reached replaces nothing.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotIdentityError, type LarkCredentials } from "@step-harness/lark-adapter";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@step-harness/coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	getBotIdentity: vi.fn(),
	close: vi.fn(async () => undefined),
}));

vi.mock("@step-harness/lark-adapter", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@step-harness/lark-adapter")>();
	return {
		...actual,
		LarkApi: class {
			getBotIdentity = api.getBotIdentity;
			close = api.close;
		},
	};
});

const { createRoomExtension } = await import("../src/ui/runtime/room-connection.ts");
type RoomInbound = import("../src/ui/runtime/room-connection.ts").RoomInbound;
type RoomTransport = import("../src/ui/runtime/room-connection.ts").RoomTransport;

const SAVED = {
	appId: "cli_saved",
	appSecret: "saved-secret",
	botOpenId: "ou_saved_bot",
	botName: "Saved bot",
	ownerOpenId: "ou_owner",
	brand: "feishu" as const,
	createdAt: new Date("2026-10-22T00:00:00Z").toISOString(),
};

let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "step-room-identity-"));
	api.getBotIdentity.mockReset();
	api.close.mockClear();
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

function harness(options: Parameters<typeof createRoomExtension>[0]) {
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
	const notifications: { message: string; level?: string }[] = [];
	const context = {
		mode: "tui",
		ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
		sessionManager: { getSessionId: () => "session-1" },
	} as unknown as ExtensionCommandContext;
	const outgoing: Array<{ role: string; text: string }> = [];
	const extensionApi = {
		registerCommand: (name: string, registration: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
			commands.set(name, registration.handler);
		},
		registerTool: () => {},
		on: () => {},
		sendUserMessage: (content: Array<{ type: string; text?: string }>) => {
			const text = content.map((part) => part.text ?? "").join("");
			outgoing.push({ role: "user", text });
		},
	} as unknown as ExtensionAPI;
	createRoomExtension(options)(extensionApi);
	return { commands, notifications, context, outgoing };
}

async function seed(record: Record<string, unknown> = SAVED) {
	await writeFile(join(directory, "room-agent.json"), JSON.stringify(record), { mode: 0o600 });
}

async function savedRecord() {
	return JSON.parse(await readFile(join(directory, "room-agent.json"), "utf8"));
}

describe("the saved room bot", () => {
	it("is reused without asking anyone to authorize again", async () => {
		await seed();
		api.getBotIdentity.mockResolvedValue({ openId: "ou_saved_bot", name: "Saved bot" });
		const authorize = vi.fn(async () => undefined);
		const h = harness({ recordDirectory: directory, authorize, rendezvous: stubRendezvous() });

		await h.commands.get("room")?.("", h.context);

		expect(authorize).not.toHaveBeenCalled();
		expect(api.getBotIdentity).toHaveBeenCalledTimes(1);
		expect(await savedRecord()).toMatchObject({ appId: "cli_saved" });
	});

	it("is replaced only when the platform refuses its credentials", async () => {
		await seed();
		api.getBotIdentity.mockRejectedValue(new BotIdentityError("credentials", "refused"));
		const authorize = vi.fn(async (_context: ExtensionContext) => ({
			credentials: { appId: "cli_fresh", appSecret: "fresh-secret", brand: "feishu" as const },
			ownerOpenId: "ou_owner",
		}));
		const h = harness({ recordDirectory: directory, authorize, rendezvous: stubRendezvous() });
		api.getBotIdentity
			.mockRejectedValueOnce(new BotIdentityError("credentials", "refused"))
			.mockResolvedValueOnce({ openId: "ou_fresh_bot", name: "Fresh bot" });

		await h.commands.get("room")?.("", h.context);

		expect(authorize).toHaveBeenCalledTimes(1);
		expect(await savedRecord()).toMatchObject({ appId: "cli_fresh", botOpenId: "ou_fresh_bot" });
	});

	it("survives an unreachable platform without touching the saved credentials", async () => {
		await seed();
		const before = await savedRecord();
		api.getBotIdentity.mockRejectedValue(new BotIdentityError("unreachable", "ENOTFOUND"));
		const authorize = vi.fn(async () => undefined);
		const h = harness({ recordDirectory: directory, authorize, rendezvous: stubRendezvous() });

		await h.commands.get("room")?.("", h.context);

		expect(authorize).not.toHaveBeenCalled();
		expect(await savedRecord()).toEqual(before);
		expect(h.notifications.some((n) => n.message.includes("连不上飞书"))).toBe(true);
		// The message must say the credentials were left alone; otherwise it reads like a failure to fix.
		expect(h.notifications.some((n) => n.message.includes("未改动"))).toBe(true);
	});
});

describe("a room this side only joined", () => {
	it("takes the first addressed message even though no bot-added event arrived", async () => {
		// The joining side is invited, not the creator, so it must learn its chat id from the message
		// itself. Requiring the event first would drop the opening turn of every joined room.
		await seed();
		api.getBotIdentity.mockResolvedValue({ openId: "ou_saved_bot", name: "Saved bot" });
		const transport = recordingTransport();
		const h = harness({ recordDirectory: directory, rendezvous: stubRendezvous(), transport: transport.build });

		await h.commands.get("room")?.("join 48291730", h.context);
		expect(transport.last?.onMessage).toBeDefined();

		transport.last?.onMessage({
			chatId: "oc_joined",
			messageId: "om_first",
			createdAt: Date.now(),
			senderType: "user",
			senderOpenId: "ou_owner",
			text: "hello from the room",
			mentions: [{ mentionedType: "user", openId: "ou_saved_bot" }],
		});

		expect(h.outgoing).toHaveLength(1);
		expect(h.outgoing[0]?.text).toContain("hello from the room");
	});

	it("still ignores a chat that was never joined", async () => {
		await seed();
		api.getBotIdentity.mockResolvedValue({ openId: "ou_saved_bot", name: "Saved bot" });
		const transport = recordingTransport();
		const h = harness({ recordDirectory: directory, rendezvous: stubRendezvous(), transport: transport.build });

		await h.commands.get("room")?.("join 48291730", h.context);
		transport.last?.onMessage({
			chatId: "oc_joined",
			messageId: "om_first",
			createdAt: Date.now(),
			senderType: "user",
			senderOpenId: "ou_owner",
			text: "first",
			mentions: [{ mentionedType: "user", openId: "ou_saved_bot" }],
		});
		transport.last?.onMessage({
			chatId: "oc_someone_else",
			messageId: "om_second",
			createdAt: Date.now(),
			senderType: "user",
			senderOpenId: "ou_owner",
			text: "not my room",
			mentions: [{ mentionedType: "user", openId: "ou_saved_bot" }],
		});

		expect(h.outgoing).toHaveLength(1);
		expect(h.outgoing[0]?.text).toContain("first");
	});
});

function recordingTransport() {
	const state: { last?: { onMessage: (message: RoomInbound) => void; onBotAdded: (chatId: string) => void } } = {};
	return {
		get last() {
			return state.last;
		},
		build: (
			_credentials: LarkCredentials,
			onMessage: (message: RoomInbound) => void,
			onBotAdded: (chatId: string) => void,
		): RoomTransport => {
			state.last = { onMessage, onBotAdded };
			return {
				start: async () => undefined,
				close: () => {},
				identity: async () => ({ openId: "ou_saved_bot", name: "Saved bot" }),
				createChat: async () => "oc_created",
				api: {
					sendText: async () => "om_x",
					sendCard: async () => "om_card",
					updateCard: async () => undefined,
					listChatMembers: async () => undefined,
					close: async () => undefined,
				},
			};
		},
	};
}

/** The room command refuses to start without a service; keep it offline but configured. */
function stubRendezvous() {
	return {
		configured: true,
		publish: async () => ({ ok: false as const, failure: { kind: "unavailable" as const, status: 0, message: "test" } }),
		status: async () => ({ ok: false as const, failure: { kind: "unavailable" as const, status: 0, message: "test" } }),
		claim: async () => ({
			ok: true as const,
			value: { code: "48291730", claimed: true, createdAt: "", expiresAt: "" },
		}),
		retire: async () => ({ ok: false as const, failure: { kind: "unavailable" as const, status: 0, message: "test" } }),
	};
}
