/**
 * Opening and continuing a room conversation.
 *
 * A room only does anything once one side speaks. The person writes to their own bot; that bot's
 * answer must address the peer's bot, because a message nobody is mentioned in never reaches the
 * other agent. These tests pin the whole chain: the group is created with both people, the peer's
 * person is invited by `union_id`, the opening message addresses the peer bot, and every reply that
 * follows keeps the turn moving until the peer-turn budget stops it.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LarkCredentials } from "@step-harness/lark-adapter";
import type { ExtensionAPI, ExtensionCommandContext } from "@step-harness/coding-agent";
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
	ownerUnionId: "on_owner_union",
	brand: "feishu" as const,
	createdAt: new Date("2026-10-22T00:00:00Z").toISOString(),
};

type PeerIdentity = NonNullable<import("../src/ui/runtime/room-rendezvous.ts").RoomPeerRecord["peer"]>;

const PEER = {
	appId: "cli_peer",
	openId: "ou_peer_bot",
	userOpenId: "ou_peer_owner",
	userUnionId: "on_peer_union",
	name: "Peer bot",
};

let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "step-room-handoff-"));
	api.getBotIdentity.mockReset();
	api.getBotIdentity.mockResolvedValue({ openId: "ou_saved_bot", name: "Saved bot" });
	await writeFile(join(directory, "room-agent.json"), JSON.stringify(SAVED), { mode: 0o600 });
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

/** Card bodies arrive as JSON; read the rendered text back so assertions match what Feishu sees. */
function renderedText(entry: Sent | undefined): string {
	if (!entry) return "";
	try {
		const card = JSON.parse(entry.body) as { elements?: { text?: { content?: string } }[] };
		return (card.elements ?? []).map((element) => element.text?.content ?? "").join("\n");
	} catch {
		return entry.body;
	}
}

interface Sent {
	kind: "card" | "text";
	chatId: string;
	body: string;
}

function makeTransport(sent: Sent[], created: Record<string, unknown>[] = [], failSend?: { now: boolean }) {
	const state: { onMessage?: (message: RoomInbound) => void; onBotAdded?: (chatId: string) => void } = {};
	const added: { ids: readonly string[]; idType: string }[] = [];
	const build = (
		_credentials: LarkCredentials,
		onMessage: (message: RoomInbound) => void,
		onBotAdded: (chatId: string) => void,
	): RoomTransport => {
		state.onMessage = onMessage;
		state.onBotAdded = onBotAdded;
		return {
			start: async () => undefined,
			close: () => {},
			identity: async () => ({ openId: "ou_saved_bot", name: "Saved bot" }),
			createChat: async (input) => {
				created.push(input as unknown as Record<string, unknown>);
				return "oc_room";
			},
			api: {
				sendText: async (chatId, text) => {
					sent.push({ kind: "text", chatId, body: text });
					return "om_text";
				},
				sendCard: async (chatId, card) => {
					if (failSend?.now) throw new Error("Lark card send failed");
					sent.push({ kind: "card", chatId, body: JSON.stringify(card) });
					return "om_card";
				},
				updateCard: async () => undefined,
				// An unreadable listing is the normal case for a launcher app; it proves nothing.
				listChatMembers: async () => undefined,
				addMembers: async (_chatId, ids, idType) => {
					added.push({ ids, idType });
					return { added: ids, failed: [], approvalPending: [] };
				},
				close: async () => undefined,
			},
		};
	};
	return { build, state, added };
}

function harness(options: Parameters<typeof createRoomExtension>[0]) {
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
	const handlers = new Map<string, (event: unknown) => void>();
	const notifications: { message: string; level?: string }[] = [];
	const tools = new Map<string, { execute: (args: Record<string, unknown>) => Promise<unknown> }>();
	const context = {
		mode: "tui",
		ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
		sessionManager: { getSessionId: () => "session-1" },
	} as unknown as ExtensionCommandContext;
	const extensionApi = {
		registerCommand: (
			name: string,
			registration: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
		) => {
			commands.set(name, registration.handler);
		},
		registerTool: (tool: { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }) => {
			tools.set(tool.name, tool);
		},
		on: (event: string, handler: (payload: unknown) => void) => {
			handlers.set(event, handler);
		},
		sendUserMessage: () => {},
	} as unknown as ExtensionAPI;
	createRoomExtension(options)(extensionApi);
	return { commands, handlers, notifications, tools, context };
}

/** A rendezvous stub that reports the peer as already claimed. */
function claimedRendezvous(peer: PeerIdentity = PEER) {
	return {
		configured: true,
		publish: async () => ({
			ok: true as const,
			value: { code: "48291730", claimed: false, createdAt: "", expiresAt: "" },
		}),
		status: async () => ({
			ok: true as const,
			value: { code: "48291730", claimed: true, peer, createdAt: "", expiresAt: "" },
		}),
		claim: async () => ({ ok: true as const, value: { code: "48291730", claimed: true, createdAt: "", expiresAt: "" } }),
		retire: async () => ({ ok: true as const, value: { retired: true } }),
	};
}

async function startRoom(overrides: Parameters<typeof createRoomExtension>[0] = { recordDirectory: directory }) {
	const sent: Sent[] = [];
	const created: Record<string, unknown>[] = [];
	const transport = makeTransport(sent, created);
	const h = harness({ ...overrides, transport: transport.build, rendezvous: claimedRendezvous() });
	await h.commands.get("room")?.("", h.context);
	// The start side polls for the claim; run the interval callback once.
	await vi.waitFor(() => expect(created.length).toBeGreaterThan(0), { timeout: 5_000 });
	return { ...h, sent, created, transport };
}

describe("opening a room", () => {
	it("invites both people by union_id so the peer's person lands in the group", async () => {
		const { created, transport } = await startRoom();
		expect(created[0]).toMatchObject({
			userIdType: "union_id",
			userIds: ["on_owner_union", "on_peer_union"],
			botIds: ["cli_saved", "cli_peer"],
		});
		// The fallback invite also runs, naming the peer in the tenant-wide id space.
		expect(transport.added).toEqual([{ ids: ["on_peer_union"], idType: "union_id" }]);
	});

	it("names the group after the room code", async () => {
		const { created } = await startRoom();
		// The code is issued randomly, so the shape is what matters: a name a person can recognise.
		expect(created[0]?.name).toMatch(/^StepCode会议室-\d{8}$/);
	});

	it("opens the conversation by addressing the peer's bot", async () => {
		const { sent } = await startRoom();
		const opening = sent.find((entry) => renderedText(entry).includes("会议室已就绪"));
		expect(opening).toBeDefined();
		expect(renderedText(opening)).toContain(`<at user_id="${PEER.openId}"></at>`);
	});

	it("falls back to the starter's own open_id when neither side published a union id", async () => {
		await writeFile(join(directory, "room-agent.json"), JSON.stringify({ ...SAVED, ownerUnionId: undefined }));
		const sent: Sent[] = [];
		const created: Record<string, unknown>[] = [];
		const transport = makeTransport(sent, created);
		const h = harness({
			recordDirectory: directory,
			transport: transport.build,
			// Neither side has one: an old record on this machine and an old peer that never sent one.
			rendezvous: claimedRendezvous({ ...PEER, userUnionId: undefined }),
		});
		await h.commands.get("room")?.("", h.context);
		await vi.waitFor(() => expect(created.length).toBeGreaterThan(0), { timeout: 5_000 });
		expect(created[0]).toMatchObject({ userIdType: "open_id", userIds: ["ou_owner"] });
	});

	it("still invites the peer person by union id when only this side's record is old", async () => {
		await writeFile(join(directory, "room-agent.json"), JSON.stringify({ ...SAVED, ownerUnionId: undefined }));
		const sent: Sent[] = [];
		const created: Record<string, unknown>[] = [];
		const transport = makeTransport(sent, created);
		const h = harness({ recordDirectory: directory, transport: transport.build, rendezvous: claimedRendezvous() });
		await h.commands.get("room")?.("", h.context);
		await vi.waitFor(() => expect(created.length).toBeGreaterThan(0), { timeout: 5_000 });
		// The peer's union id alone is enough to put them in the group; dropping it would be wrong.
		expect(created[0]).toMatchObject({ userIdType: "union_id", userIds: [PEER.userUnionId] });
	});
});

describe("continuing a room", () => {
	function assistantReply(text: string) {
		return { message: { role: "assistant", content: [{ type: "text", text }] } };
	}

	it("hands a human-triggered reply to the peer bot", async () => {
		const { sent, transport, handlers, tools } = await startRoom();
		sent.length = 0;
		transport.state.onMessage?.({
			chatId: "oc_room",
			messageId: "om_human",
			createdAt: Date.now(),
			senderType: "user",
			senderOpenId: "ou_owner",
			text: "把结论发给对方",
			mentions: [{ mentionedType: "user", openId: "ou_saved_bot" }],
		});
		await tools.get("room_send")?.execute({ summary: "结论是 X", handOff: true });
		handlers.get("message_end")?.(assistantReply("结论是 X"));
		await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0), { timeout: 5_000 });
		expect(renderedText(sent[0])).toContain(`<at user_id="${PEER.openId}"></at>`);
	});

	it("does not forward a human's question to the peer unless the agent asks", async () => {
		const { sent, transport, handlers } = await startRoom();
		sent.length = 0;
		// Asking one's own agent something is not a message to the other side. The room is already
		// open (the greeting addressed the peer), so forwarding every question would just interrupt.
		for (let turn = 0; turn < 3; turn += 1) {
			transport.state.onMessage?.({
				chatId: "oc_room",
				messageId: `om_human_${turn}`,
				createdAt: Date.now() + turn,
				senderType: "user",
				senderOpenId: "ou_owner",
				text: `自己的问题 ${turn}`,
				mentions: [{ mentionedType: "user", openId: "ou_saved_bot" }],
			});
			handlers.get("message_end")?.(assistantReply(`自己的回答 ${turn}`));
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(sent.filter((entry) => renderedText(entry).includes(`<at user_id="${PEER.openId}"></at>`))).toHaveLength(0);
	});

	it("retries the same reply after a failed send instead of treating it as spoken", async () => {
		const sent: Sent[] = [];
		const created: Record<string, unknown>[] = [];
		const failSend = { now: true };
		const transport = makeTransport(sent, created, failSend);
		const h = harness({ recordDirectory: directory, transport: transport.build, rendezvous: claimedRendezvous() });
		await h.commands.get("room")?.("", h.context);
		await vi.waitFor(() => expect(created.length).toBeGreaterThan(0), { timeout: 5_000 });
		sent.length = 0;

		transport.state.onMessage?.({
			chatId: "oc_room",
			messageId: "om_fail",
			createdAt: Date.now(),
			senderType: "bot",
			senderOpenId: PEER.openId,
			text: "你那边如何",
			mentions: [{ mentionedType: "bot", openId: "ou_saved_bot" }],
		});
		// The platform rejects the send: the reply never reached the group.
		h.handlers.get("message_end")?.(assistantReply("相同内容"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(sent).toHaveLength(0);

		// The next turn with the same text must still be delivered, not skipped as a duplicate.
		failSend.now = false;
		h.handlers.get("message_end")?.(assistantReply("相同内容"));
		await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5_000 });
		expect(renderedText(sent[0])).toContain("相同内容");
	});

	it("still posts the next turn's reply after an interrupted turn", async () => {
		const { sent, transport, handlers, tools } = await startRoom();
		sent.length = 0;
		transport.state.onMessage?.({
			chatId: "oc_room",
			messageId: "om_interrupted",
			createdAt: Date.now(),
			senderType: "bot",
			senderOpenId: PEER.openId,
			text: "先说说你的判断",
			mentions: [{ mentionedType: "bot", openId: "ou_saved_bot" }],
		});
		await tools.get("room_send")?.execute({ summary: "toolA", handOff: false });
		// The turn is interrupted: no `message_end` ever arrives for it.
		transport.state.onMessage?.({
			chatId: "oc_room",
			messageId: "om_int__next",
			createdAt: Date.now() + 1,
			senderType: "bot",
			senderOpenId: PEER.openId,
			text: "继续",
			mentions: [{ mentionedType: "bot", openId: "ou_saved_bot" }],
		});
		handlers.get("message_end")?.(assistantReply("plainB"));
		await vi.waitFor(() => expect(renderedText(sent.at(-1))).toContain("plainB"), { timeout: 5_000 });
		// The stale tool flag must not make this turn believe its reply was already posted.
		expect(renderedText(sent.at(-1))).toContain("plainB");
	});

	it("posts a room_send message exactly once, even with the reply that follows", async () => {
		const { sent, transport, handlers, tools } = await startRoom();
		sent.length = 0;
		transport.state.onMessage?.({
			chatId: "oc_room",
			messageId: "om_peer_once",
			createdAt: Date.now(),
			senderType: "bot",
			senderOpenId: PEER.openId,
			text: "给我一份结论",
			mentions: [{ mentionedType: "bot", openId: "ou_saved_bot" }],
		});
		await tools.get("room_send")?.execute({ summary: "结论 X", handOff: true });
		handlers.get("message_end")?.(assistantReply("结论 X"));
		await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0), { timeout: 5_000 });
		// The tool already posted it; the turn must not post the same text a second time.
		expect(sent).toHaveLength(1);
		expect(renderedText(sent[0])).toContain("结论 X");
	});

	it("ends the exchange when the agent says it is settled", async () => {
		const { sent, transport, handlers, tools } = await startRoom();
		sent.length = 0;
		transport.state.onMessage?.({
			chatId: "oc_room",
			messageId: "om_peer_quiet",
			createdAt: Date.now(),
			senderType: "bot",
			senderOpenId: PEER.openId,
			text: "我这边已经齐了",
			mentions: [{ mentionedType: "bot", openId: "ou_saved_bot" }],
		});
		// `handOff: false` is the agent's "we are done" signal; the reply must not address the peer.
		await tools.get("room_send")?.execute({ summary: "好的，收到", handOff: false });
		handlers.get("message_end")?.(assistantReply("好的，收到"));
		await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0), { timeout: 5_000 });
		expect(sent).toHaveLength(1);
		expect(renderedText(sent[0])).not.toContain(`<at user_id="${PEER.openId}"></at>`);
	});

	it("hands a peer-triggered reply back to the peer bot", async () => {
		const { sent, transport, handlers, tools } = await startRoom();
		sent.length = 0;
		transport.state.onMessage?.({
			chatId: "oc_room",
			messageId: "om_peer",
			createdAt: Date.now(),
			senderType: "bot",
			senderOpenId: PEER.openId,
			text: "我这边看是这样",
			mentions: [{ mentionedType: "bot", openId: "ou_saved_bot" }],
		});
		await tools.get("room_send")?.execute({ summary: "收到，补充一点", handOff: true });
		handlers.get("message_end")?.(assistantReply("收到，补充一点"));
		await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0), { timeout: 5_000 });
		expect(renderedText(sent[0])).toContain(`<at user_id="${PEER.openId}"></at>`);
	});

	it("stops handing off once the peer-turn budget is spent", async () => {
		const { sent, transport, handlers, tools } = await startRoom();
		sent.length = 0;
		for (let turn = 0; turn < 6; turn += 1) {
			transport.state.onMessage?.({
				chatId: "oc_room",
				messageId: `om_peer_${turn}`,
				createdAt: Date.now() + turn,
				senderType: "bot",
				senderOpenId: PEER.openId,
				text: `peer turn ${turn}`,
				mentions: [{ mentionedType: "bot", openId: "ou_saved_bot" }],
			});
			await tools.get("room_send")?.execute({ summary: `reply ${turn}`, handOff: true });
			handlers.get("message_end")?.(assistantReply(`reply ${turn}`));
		}
		await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0), { timeout: 5_000 });
		const addressed = sent.filter((entry) => renderedText(entry).includes(`<at user_id="${PEER.openId}"></at>`));
		// The budget caps hand-offs at MAX_PEER_TURNS (4) no matter how many turns were attempted.
		expect(addressed.length).toBeLessThanOrEqual(4);
		expect(addressed.length).toBeGreaterThan(0);
		// The final reply still reaches the room, just without waking the peer.
		expect(renderedText(sent.at(-1))).not.toContain(`<at user_id="${PEER.openId}"></at>`);
	});

	it("says goodbye in the group when the room is left", async () => {
		const { sent, commands, context } = await startRoom();
		sent.length = 0;
		await commands.get("room")?.("leave", context);
		expect(sent.some((entry) => renderedText(entry).includes("会议室已结束"))).toBe(true);
	});
});
