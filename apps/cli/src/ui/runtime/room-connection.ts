/**
 * `/room`: put this session and another person's session in one Feishu group.
 *
 * The command owns the whole lifecycle for one room: reuse or create this person's own room bot,
 * publish a short code, wait for the other terminal to claim it, create the group, and bind it to
 * this session. Inbound messages are arbitrated by `@step-harness/step-room`, which decides whether
 * this agent speaks; this file only moves text and wires events.
 */

import { randomUUID } from "node:crypto";
import type {
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	MessageEndEvent,
} from "@step-harness/coding-agent";
import { BotIdentityError, LarkApi, type LarkCredentials } from "@step-harness/lark-adapter";
import type { TextContent } from "@step-harness/providers";
import {
	decideRoomTurn,
	parseRoomCommand,
	type RoomAgentRecord,
	RoomAgentStore,
	RoomBindingStore,
	RoomCodeBook,
	shouldHandOff,
} from "@step-harness/step-room";
import {
	describeFailure,
	newRoomSecret,
	ROOM_RENDEZVOUS_URL_ENV,
	type RoomPeerRecord,
	RoomRendezvousClient,
} from "./room-rendezvous.ts";

/** How often the waiting side asks the rendezvous service whether anyone joined. */
const POLL_INTERVAL_MS = 2_000;
const MAX_PEER_TURNS = 4;
const ROOM_TOOL = "room_send";

/**
 * Appended to every room message so the agent knows the rules of the turn it is about to take.
 * The room must end when the work is settled: an agent that always answers keeps both sides
 * talking forever, because each reply is a new message the other side is addressed in.
 */
const ROOM_PROTOCOL_NOTE =
	"[room protocol] You are in a StepCode room with another person's agent. Reply normally, and use room_send " +
	"to share anything the other side cannot see. Add handOff: true only if the other agent still has work to do " +
	"with what you are sending. If the matter is settled — you agree, or there is nothing left for them to act on " +
	"— send without handOff, or just reply: the exchange then stops until a human addresses an agent again.";

/** What the product needs from the platform; kept small so a test can stand in for it. */
export interface RoomTransport {
	/** Start listening. Resolves once the platform confirms the connection. */
	start(): Promise<void>;
	close(): void;
	/** This bot's own open id and display name. */
	identity(): Promise<{ openId: string; name: string }>;
	/** Create the group with this bot already inside. Returns the chat id. */
	createChat(input: {
		name: string;
		/** People by an id in `userIdType`'s space. */
		userIds?: readonly string[];
		userIdType?: "open_id" | "union_id";
		/** Kept for callers whose people are all in this app's own scope. */
		userOpenIds?: readonly string[];
		botIds: readonly string[];
		ownerOpenId?: string;
		dedupeKey: string;
	}): Promise<string>;
	/** Provider-side conversation used for every room message in this session. */
	api: {
		sendText(chatId: string, text: string, replyTo?: string): Promise<string>;
		sendCard(chatId: string, card: Record<string, unknown>, replyTo?: string): Promise<string>;
		updateCard(messageId: string, card: Record<string, unknown>): Promise<void>;
		/** `undefined` when the tenant cannot read members; never conflated with an empty listing. */
		listChatMembers(
			chatId: string,
		): Promise<readonly { openId: string; memberType: "user" | "bot" | "unknown" }[] | undefined>;
		/** Add people to an existing chat. Partial failures are reported, never thrown away. */
		addMembers(
			chatId: string,
			ids: readonly string[],
			idType: "open_id" | "union_id",
		): Promise<{ added: readonly string[]; failed: readonly string[]; approvalPending: readonly string[] }>;
		close(): Promise<void>;
	};
}

export interface RoomInbound {
	chatId: string;
	messageId: string;
	createdAt: number;
	senderType?: string;
	senderOpenId?: string;
	text: string;
	mentions: readonly { mentionedType?: string; openId?: string }[];
}

export interface RoomExtensionOptions {
	/** Where the bot record lives; injected so tests never touch the user's home. */
	recordDirectory: string;
	/** Turn a fresh authorization into credentials. Absent means the room command stays off. */
	authorize?: (
		context: ExtensionContext,
	) => Promise<{ credentials: LarkCredentials; ownerOpenId: string; ownerUnionId?: string } | undefined>;
	/** Build the live transport from credentials. Absent in tests that supply no platform. */
	transport?: (
		credentials: LarkCredentials,
		onMessage: (message: RoomInbound) => void,
		onBotAdded: (chatId: string) => void,
	) => RoomTransport;
	/** Rendezvous client; defaults to the trial deployment. */
	/** Only the calls the command makes, so a test can stand in without impersonating the class. */
	rendezvous?: Pick<RoomRendezvousClient, "configured" | "publish" | "status" | "claim" | "retire">;
	/** Title for the group; receives the room code so the name is recognisable at a glance. */
	roomName?: (selfName: string, peerName: string | undefined, code: string) => string;
}

interface ActiveRoom {
	roomId: string;
	code: string;
	secret: string;
	chatId: string;
	appId: string;
	/** The person who started the room; they own the group. */
	ownerOpenId: string;
	/** The same person in the tenant-wide id space, so the other side can invite them. */
	ownerUnionId?: string;
	botOpenId: string;
	botName: string;
	transport: RoomTransport;
	/** `openId` is the peer's bot; `userUnionId` is the peer himself, addable from either side. */
	peer?: { appId: string; openId: string; userOpenId: string; userUnionId?: string; name?: string };
	/** The session this room speaks for; needed to bind a chat that arrives before any event does. */
	sessionId: string;
	/** The message id last posted by this side; used for cancel/replace of a live card. */
	lastSpoken?: string;
	/**
	 * The text last posted by this side, kept separately from `lastSpoken`: that field holds a
	 * message id after a send, so comparing assistant text against it would always report a change
	 * and post the same reply twice.
	 */
	lastSpokenText?: string;
	/**
	 * Who triggered the turn currently running, so the reply can be attributed and the peer-turn
	 * budget advanced correctly.
	 */
	pendingAddressedBy?: "user" | "bot" | "self";
	/**
	 * Set by `room_send` when the agent wants the peer to respond. Absent means "I am done": the
	 * reply still reaches the room, but it does not address the peer bot, and the exchange goes
	 * quiet until a human on either side starts it again.
	 */
	pendingHandOff?: boolean;
	/** Whether a bot-to-bot exchange is in flight; used only to decide whether to report its end. */
	exchangeOpen?: boolean;
	/** Set when `room_send` posted the message for this turn, so `message_end` stays silent. */
	pendingSpokenInTool?: boolean;
	/** The terminal this room reports to, kept for callbacks that have no command context. */
	ui?: { notify(message: string, level?: "info" | "warning" | "error"): void };
	polling?: NodeJS.Timeout;
}

export function createRoomExtension(options: RoomExtensionOptions): ExtensionFactory {
	const store = new RoomAgentStore({ directory: options.recordDirectory });
	const rendezvous = options.rendezvous ?? new RoomRendezvousClient();
	return (pi) => {
		let room: ActiveRoom | undefined;
		let codes: RoomCodeBook | undefined;
		let bindings: RoomBindingStore | undefined;
		let peerTurns = 0;

		// The room code is the one identifier both people already share, so it is what the group is
		// named after; `roomId` is an internal UUID nobody has seen.
		const title = (self: string, peer: string | undefined, code: string) =>
			options.roomName?.(self, peer, code) ??
			(code ? `StepCode会议室-${code}` : `room-${room?.roomId.slice(0, 8) ?? "new"}`);

		const stop = async (notify: boolean, context?: ExtensionCommandContext) => {
			const current = room;
			room = undefined;
			peerTurns = 0;
			if (!current) {
				if (notify) context?.ui.notify("room · 当前不在会议室", "info");
				return;
			}
			// Say goodbye before tearing the transport down: the other side would otherwise keep
			// addressing an agent that has already stopped listening.
			if (current.chatId) {
				await current.transport.api
					.sendCard(current.chatId, card(`会议室已结束：${current.botName} 已离开。`))
					.catch(() => undefined);
			}
			if (current.polling) clearInterval(current.polling);
			current.transport.close();
			await current.transport.api.close().catch(() => undefined);
			if (current.secret) await rendezvous.retire(current.code, current.secret).catch(() => undefined);
			codes?.revoke(current.roomId);
			bindings = undefined;
			if (notify) context?.ui.notify("room · 已离开会议室", "info");
		};

		/**
		 * Speak into the room. `handOffTo` addresses the peer's bot, which is what makes the other
		 * side's agent take a turn; leaving it out posts the message without waking anyone.
		 *
		 * `lastSpokenText` records the text *without* the address prefix: it is compared against
		 * assistant output to decide whether a reply is already in the group, and the assistant never
		 * writes the `<at>` markup itself.
		 */
		const speak = async (text: string, handOffTo: string | undefined) => {
			const current = room;
			if (!current?.chatId) return;
			const body = handOffTo ? `<at user_id="${handOffTo}"></at> ${text}` : text;
			try {
				current.lastSpoken = await current.transport.api.sendCard(current.chatId, card(body));
				// Only a message that actually reached the group counts as spoken; recording it first
				// would make a failed send look delivered and suppress the retry on the next turn.
				current.lastSpokenText = text;
			} catch {
				// The room is a projection of the session, never its source of truth.
			}
		};

		const handleInbound = (message: RoomInbound) => {
			const current = room;
			if (!current) return;
			// The joining side is invited rather than creating the group, so a bot-added event may never
			// arrive for it. A message addressed to this bot in the room it is waiting on is itself
			// proof of membership; binding here beats dropping the first turn of every joined room.
			if (!bindings && current.sessionId) {
				current.chatId = current.chatId || message.chatId;
				if (current.chatId === message.chatId) {
					bindings = new RoomBindingStore();
					bindings.bind(message.chatId, current.sessionId);
				}
			}
			if (!bindings) return;
			if (bindings.resolve(message.chatId).action === "drop") {
				// Unbound chat: nobody in this terminal asked for it, and replying would be noise.
				return;
			}
			const decision = decideRoomTurn(
				{
					id: message.messageId,
					chatId: message.chatId,
					createdAt: message.createdAt,
					...(message.senderType ? { senderType: message.senderType } : {}),
					...(message.senderOpenId ? { senderOpenId: message.senderOpenId } : {}),
					mentions: message.mentions.map((mention) => ({
						...(mention.mentionedType ? { mentionedType: mention.mentionedType } : {}),
						...(mention.openId ? { openId: mention.openId } : {}),
					})),
				},
				{ selfOpenId: current.botOpenId, maxPeerTurns: MAX_PEER_TURNS, peerTurns },
			);
			if (!decision.speak) return;
			// A human talking to this side restarts the exchange. A peer's turn is counted when this
			// side actually hands the word back (see `message_end`), not on arrival, so the budget
			// measures round-trips instead of inbound messages.
			peerTurns = decision.addressedBy === "user" ? 0 : peerTurns;
			// Remember who triggered this turn; `message_end` needs it to decide the hand-off. A new
			// turn starts clean: if the previous one was interrupted before its reply landed, a stale
			// `pendingSpokenInTool` would make this turn believe its message was already posted and
			// drop it silently.
			current.pendingAddressedBy = decision.addressedBy;
			current.pendingHandOff = undefined;
			current.pendingSpokenInTool = undefined;
			current.exchangeOpen = true;
			// A peer bot is untrusted input: it becomes a user message, never a tool instruction, and
			// this session's own permission policy still governs whatever it asks for.
			const content: TextContent[] = [
				{
					type: "text",
					text: `[room · ${message.senderType ?? "unknown"} · ${message.senderOpenId ?? "unknown"}] ${message.text}`,
				},
				{ type: "text", text: ROOM_PROTOCOL_NOTE },
			];
			pi.sendUserMessage(content, { deliverAs: "followUp", expandPromptTemplates: false });
		};

		/**
		 * The one bot this person keeps for rooms.
		 *
		 * A saved bot is reused on every run and only replaced when the platform says its credentials
		 * no longer work. Any other failure — an unreachable platform, a timeout — leaves the record
		 * untouched: asking someone to re-authorize because their connection blinked is how a "fixed"
		 * bot quietly turns into a new app on every flaky day.
		 */
		const ensureRecord = async (context: ExtensionCommandContext): Promise<RoomAgentRecord | undefined> => {
			const existing = await store.read();
			if (existing.status === "found") {
				const probe = new LarkApi(credentialsOf(existing.record));
				try {
					const identity = await probe.getBotIdentity();
					return { ...existing.record, botOpenId: identity.openId, botName: identity.name };
				} catch (error) {
					const code = error instanceof BotIdentityError ? error.code : "unreachable";
					// Only a refusal by the platform proves the credentials are dead.
					if (code === "unreachable") {
						context.ui.notify("room · 连不上飞书，稍后重试 /room（本机机器人凭证未改动）", "warning");
						return undefined;
					}
					context.ui.notify("room · 已保存的机器人不可用（可能已被删除或重置），需要重新授权", "warning");
				} finally {
					await probe.close().catch(() => undefined);
				}
			} else if (existing.status === "invalid") {
				context.ui.notify(`room · 机器人凭证文件不可用（${existing.reason}），需要重新授权`, "warning");
			}
			if (!options.authorize) {
				context.ui.notify("room · 尚未接入机器人授权，无法发起房间", "warning");
				return undefined;
			}
			const authorized = await options.authorize(context);
			if (!authorized) {
				context.ui.notify("room · 授权未完成", "warning");
				return undefined;
			}
			const { credentials, ownerOpenId, ownerUnionId } = authorized;
			const probe = new LarkApi(credentials);
			try {
				const identity = await probe.getBotIdentity();
				const record: RoomAgentRecord = {
					appId: credentials.appId,
					appSecret: credentials.appSecret,
					botOpenId: identity.openId,
					botName: identity.name,
					ownerOpenId,
					...(ownerUnionId ? { ownerUnionId } : {}),
					brand: credentials.brand,
					createdAt: new Date().toISOString(),
				};
				await store.write(record);
				return record;
			} catch {
				context.ui.notify("room · 机器人身份校验失败，请重试授权", "warning");
				return undefined;
			} finally {
				await probe.close().catch(() => undefined);
			}
		};

		const connect = async (
			record: RoomAgentRecord,
			context: ExtensionCommandContext,
		): Promise<RoomTransport | undefined> => {
			if (!options.transport) {
				context.ui.notify("room · 传输层未配置", "warning");
				return undefined;
			}
			const transport = options.transport(credentialsOf(record), handleInbound, (chatId) =>
				adoptChat(chatId, context),
			);
			try {
				await transport.start();
				return transport;
			} catch {
				transport.close();
				context.ui.notify("room · 连接飞书失败：请确认应用已发布，并已开启长连接事件订阅", "warning");
				return undefined;
			}
		};

		/** Start side: show a code, publish it, then wait for the newcomer. */
		const startRoom = async (context: ExtensionCommandContext) => {
			// Check the service before doing any work: creating a bot and connecting only to be told the
			// deployment is missing wastes the person's time and leaves a room that cannot be joined.
			if (!rendezvous.configured) {
				context.ui.notify(`room · 未配置房间服务地址，请设置 ${ROOM_RENDEZVOUS_URL_ENV}`, "warning");
				return;
			}
			const record = await ensureRecord(context);
			if (!record) return;
			const transport = await connect(record, context);
			if (!transport) return;

			const self = await transport.identity();
			const roomId = randomUUID();
			codes = new RoomCodeBook();
			const code = codes.issue(roomId, 8);
			const secret = newRoomSecret();
			const published = await rendezvous.publish(code, secret);
			if (!published.ok) {
				transport.close();
				await transport.api.close().catch(() => undefined);
				context.ui.notify(`room · ${describeFailure(published.failure)}`, "warning");
				return;
			}

			room = {
				roomId,
				code,
				secret,
				chatId: "",
				appId: record.appId,
				ownerOpenId: record.ownerOpenId,
				...(record.ownerUnionId ? { ownerUnionId: record.ownerUnionId } : {}),
				botOpenId: self.openId,
				botName: self.name,
				transport,
				sessionId: context.sessionManager.getSessionId(),
				ui: context.ui,
			};
			if (!record.ownerUnionId) {
				// Not a failure and not fixable by re-authorizing: the device flow cannot hand out a
				// tenant-wide id. This side joins the group itself once the other side creates it, so
				// the room still ends up with both people in it.
				context.ui.notify(
					"room · 建群时只用本应用内的身份，进入房间后你会把自己加进群（需要 im:chat.members:write_only）",
					"info",
				);
			}
			context.ui.notify(`room · @${self.name} · 房间码 ${code} · 2 分钟内有效，念给对方`, "info");

			room.polling = setInterval(() => {
				void pollForPeer(context);
			}, POLL_INTERVAL_MS);
		};

		/**
		 * Tear down a room that can never open, so a later `/room_send` cannot report success for a
		 * message with nowhere to go. Called only by paths that have already decided the room is dead.
		 */
		const abandonWaitingRoom = async (current: ActiveRoom) => {
			if (room !== current) return;
			if (current.polling) clearInterval(current.polling);
			current.polling = undefined;
			room = undefined;
			peerTurns = 0;
			// The per-turn fields live on the discarded object, so they die with it. Clearing them here
			// keeps this teardown independent of `handleInbound` resetting them on the next turn.
			current.pendingAddressedBy = undefined;
			current.pendingHandOff = undefined;
			current.pendingSpokenInTool = undefined;
			current.transport.close();
			await current.transport.api.close().catch(() => undefined);
		};

		const pollForPeer = async (context: ExtensionCommandContext) => {
			const current = room;
			if (!current || current.chatId || !current.secret) return;
			const result = await rendezvous.status(current.code, current.secret);
			if (!result.ok) {
				if (result.failure.kind === "not-found" || result.failure.kind === "throttled") {
					// The code is gone: nothing will ever create this group, and keeping the room open
					// would leave the tool looking usable while it has nowhere to send.
					await abandonWaitingRoom(current);
					context.ui.notify(`room · ${describeFailure(result.failure)}，请重新 /room`, "warning");
				}
				return;
			}
			if (!result.value.claimed || !result.value.peer) return;
			if (current.polling) clearInterval(current.polling);
			current.polling = undefined;
			await createGroup(context, result.value);
		};

		/**
		 * Confirm the invite landed.
		 *
		 * `undefined` means the tenant cannot read members at all — the launcher template grants no
		 * chat-read scope, so this is the common case and proves nothing. Only a listing we actually
		 * received may be read as evidence that someone is missing.
		 */
		const verifyMembers = (
			current: ActiveRoom,
			context: ExtensionCommandContext,
			members: readonly { openId: string; memberType: string }[] | undefined,
		) => {
			if (!members) return;
			const hasPeerBot = members.some(
				(member) => member.memberType === "bot" && member.openId !== current.botOpenId,
			);
			if (!hasPeerBot) {
				context.ui.notify("room · 群已建好，但对方机器人没进群，请在飞书里手动拉一次", "warning");
			}
			const humans = members.filter((member) => member.memberType === "user").length;
			if (humans < 2) {
				context.ui.notify(`room · 群里只有 ${humans} 个人，请把对方也拉进来`, "warning");
			}
		};

		/** Invite the people who belong in the room, naming the id space so no id is cross-app. */
		const invitePeople = (current: ActiveRoom): { userIds: string[]; userIdType: "open_id" | "union_id" } => {
			const peerUnionId = current.peer?.userUnionId;
			// `union_id` is tenant-wide, so one list carries both people regardless of which app
			// created them. This is the only way to put the peer *person* in a group we create, so it
			// wins whenever either union id is known — a peer's union id is still usable even when this
			// side's old record has none.
			if (current.ownerUnionId || peerUnionId) {
				return {
					userIds: [current.ownerUnionId, peerUnionId].filter((id): id is string => Boolean(id)),
					userIdType: "union_id",
				};
			}
			// Neither side published a union id: our own open id is still resolvable in our own scope.
			// The peer is left out here and reported by `ensurePeerPerson`, which is honest about it.
			return { userIds: [current.ownerOpenId], userIdType: "open_id" };
		};

		/**
		 * After the group exists, make sure the peer's person is actually in it.
		 *
		 * Creating the group with a `union_id` is expected to place the person directly; this call is
		 * the belt-and-braces path for when it does not. A member listing is keyed by `open_id`, so it
		 * cannot tell us whether a given *union_id* is inside — but when it shows two people, both are
		 * there and there is nothing to add. Every failure is reported: a silently missing person is
		 * exactly what makes a room look like it is working when it is not.
		 */
		const ensurePeerPerson = async (
			current: ActiveRoom,
			context: ExtensionCommandContext,
			members: readonly { memberType: string }[] | undefined,
		) => {
			const peerUnionId = current.peer?.userUnionId;
			if (!peerUnionId) {
				// Expected: the device flow never provides one. The peer's bot adds its own person as
				// soon as it is in the group, which needs no id this side could resolve.
				context.ui.notify("room · 对方会在进群后自己加入，无需手动操作", "info");
				return;
			}
			// The group was created with this union id already listed, so two people in a readable
			// listing means the create call did its job. An unreadable listing (`undefined`) proves
			// nothing either way, but adding is idempotent — asking again is the only way to find out,
			// and a person already present is simply not reported.
			if (members && members.filter((member) => member.memberType === "user").length >= 2) return;
			try {
				const result = await current.transport.api.addMembers(current.chatId, [peerUnionId], "union_id");
				if (result.failed.length) {
					context.ui.notify("room · 邀请对方本人进群失败（id 无效），请在飞书里手动拉一次", "warning");
				} else if (result.approvalPending.length) {
					context.ui.notify("room · 对方本人进群需要对方管理员审批", "info");
				}
			} catch (error) {
				// The create call already added whoever it could; this is the fallback, so say how to
				// proceed by hand and keep the room working rather than failing a usable room.
				const detail = error instanceof Error ? error.message : String(error);
				context.ui.notify(
					`room · 未能自动把对方本人拉进群（${detail}）；请在飞书里把对方加进来，或给对方机器人开通 im:chat.members:write_only`,
					"warning",
				);
			}
		};

		const createGroup = async (context: ExtensionCommandContext, record: RoomPeerRecord) => {
			const current = room;
			const peer = record.peer;
			if (!current || !peer) return;
			current.peer = {
				appId: peer.appId,
				openId: peer.openId,
				userOpenId: peer.userOpenId,
				...(peer.userUnionId ? { userUnionId: peer.userUnionId } : {}),
				...(peer.name ? { name: peer.name } : {}),
			};
			const invitees = invitePeople(current);
			let chatId: string;
			try {
				chatId = await current.transport.createChat({
					name: title(current.botName, peer.name, current.code),
					...invitees,
					// Bots are named by application id (`cli_…`), which is tenant-wide and needs no
					// per-app id translation.
					botIds: [current.appId, peer.appId],
					ownerOpenId: current.ownerOpenId,
					dedupeKey: current.roomId,
				});
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				// There is no group and no second chance at one: this code was already claimed, so the
				// room cannot open. Close it rather than leaving a tool that reports success.
				await abandonWaitingRoom(current);
				await rendezvous.retire(current.code, current.secret).catch(() => undefined);
				context.ui.notify(`room · 建群失败：${detail}，请重新 /room`, "warning");
				return;
			}
			current.chatId = chatId;
			bindings = new RoomBindingStore();
			bindings.bind(chatId, context.sessionManager.getSessionId());
			// Read the listing once: it costs a platform call, and both checks need the same snapshot.
			const members = await current.transport.api.listChatMembers(current.chatId);
			await ensurePeerPerson(current, context, members);
			verifyMembers(current, context, members);
			await rendezvous.retire(current.code, current.secret).catch(() => undefined);
			await openConversation(current, context);
			context.ui.notify(`room · 群已就绪 · 在群里 @${current.botName} 开始`, "info");
		};

		/** Joining side: publish this bot's identity onto the code the other person read out. */
		const joinRoom = async (code: string, context: ExtensionCommandContext) => {
			if (!rendezvous.configured) {
				context.ui.notify(`room · 未配置房间服务地址，请设置 ${ROOM_RENDEZVOUS_URL_ENV}`, "warning");
				return;
			}
			if (!/^\d{6,12}$/.test(code)) {
				context.ui.notify("room · 房间码应为 6-12 位数字", "warning");
				return;
			}
			const record = await ensureRecord(context);
			if (!record) return;
			const transport = await connect(record, context);
			if (!transport) return;
			const self = await transport.identity();

			const claimed = await rendezvous.claim(code, {
				appId: record.appId,
				openId: record.botOpenId,
				userOpenId: record.ownerOpenId,
				...(record.ownerUnionId ? { userUnionId: record.ownerUnionId } : {}),
				name: self.name,
			});
			if (!claimed.ok) {
				transport.close();
				await transport.api.close().catch(() => undefined);
				context.ui.notify(`room · ${describeFailure(claimed.failure)}`, "warning");
				return;
			}
			room = {
				roomId: code,
				code,
				secret: "",
				chatId: "",
				appId: record.appId,
				ownerOpenId: record.ownerOpenId,
				...(record.ownerUnionId ? { ownerUnionId: record.ownerUnionId } : {}),
				botOpenId: self.openId,
				botName: self.name,
				transport,
				sessionId: context.sessionManager.getSessionId(),
				ui: context.ui,
			};
			context.ui.notify("room · 已登记，等待对方建群后把你拉进群（进群后即可对话）", "info");
		};

		/**
		 * The joining side learns its group id only by being added to it: Feishu reports that through
		 * the bot-added event, and that is the moment this session can start receiving room messages.
		 */
		const adoptChat = (chatId: string, context: ExtensionContext) => {
			const current = room;
			if (!current) return;
			if (current.chatId && current.chatId !== chatId) return;
			const first = !current.chatId;
			current.chatId = chatId;
			if (!bindings) {
				bindings = new RoomBindingStore();
				bindings.bind(chatId, context.sessionManager.getSessionId());
			}
			// Being added is the only signal this side gets that the room is open. Staying silent here
			// leaves the person watching "waiting for the other side", which reads as a hang.
			if (first) {
				context.ui.notify(`room · 已进群，可以开始对话（@${current.botName} 或直接说话）`, "info");
				// The group was created by the other side, which cannot name this person: only an
				// id from *this* app's scope resolves here, and the device flow cannot hand out the
				// tenant-wide one. This bot is in the group already, so it adds its own person itself.
				void joinOwnPerson(current, context);
			}
		};

		/**
		 * Joining side: put this person into the group, using this app's own id space.
		 *
		 * `ownerOpenId` is only meaningful to the app that issued it, which is exactly the app whose
		 * token is calling — so no cross-app id is involved. Requires `im:chat` or
		 * `im:chat.members:write_only`; without it the person is told to add themselves by hand
		 * rather than left wondering why the room looks half-joined.
		 */
		const joinOwnPerson = async (current: ActiveRoom, context: ExtensionContext) => {
			try {
				const result = await current.transport.api.addMembers(current.chatId, [current.ownerOpenId], "open_id");
				if (result.failed.length) {
					context.ui.notify("room · 未能把自己加进群（id 无效），请在飞书里手动加入", "warning");
				} else if (result.approvalPending.length) {
					context.ui.notify("room · 你加入群需要管理员审批", "info");
				}
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				context.ui.notify(`room · 未能自动把自己加进群（${detail}），请在飞书里手动加入`, "warning");
			}
		};

		/**
		 * Open the conversation.
		 *
		 * A room is only useful once one side speaks, and nothing starts on its own: the starting
		 * side's bot posts the first message and addresses the peer bot, which is what wakes the
		 * peer's agent. Without this the two people stare at a group where neither agent says
		 * anything.
		 */
		const openConversation = async (current: ActiveRoom, context: ExtensionCommandContext) => {
			const peer = current.peer;
			if (!current.chatId || !peer) return;
			const handOff = `<at user_id="${peer.openId}"></at>`;
			const opening =
				`${handOff} 会议室已就绪：${current.botName} ↔ ${peer.name ?? "对方 agent"}。` +
				"请在群里 @ 自己的机器人说明要一起讨论的事，两边会交替接棒。";
			current.lastSpokenText = opening;
			try {
				current.lastSpoken = await current.transport.api.sendCard(current.chatId, card(opening));
			} catch {
				// Failing to announce does not invalidate the room; the person can still @ their bot.
				context.ui.notify("room · 群已建好，但开场消息发送失败，请直接在群里 @ 自己的机器人", "warning");
			}
		};

		pi.registerCommand("room", {
			description: "Start or join a room with another person's agent; /room leave to stop",
			handler: async (args, context) => {
				if (context.mode !== "tui") {
					context.ui.notify("room · 需要交互式终端", "warning");
					return;
				}
				const action = parseRoomCommand(args);
				if (action.kind === "leave") {
					await stop(true, context);
					return;
				}
				if (action.kind === "invalid") {
					context.ui.notify("room · 用法：/room、/room join <房间码>、/room leave", "warning");
					return;
				}
				if (room) {
					context.ui.notify("room · 已在会议室中，先 /room leave", "warning");
					return;
				}
				if (action.kind === "join") await joinRoom(action.code, context);
				else await startRoom(context);
			},
		});

		pi.on("session_shutdown", () => {
			void stop(false);
		});

		// Assistant output reaches the room through the existing message stream, not a second loop.
		pi.on("message_end", (event: Pick<MessageEndEvent, "message">) => {
			if (!room || event.message.role !== "assistant") return;
			const text = event.message.content
				.filter((part): part is TextContent => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.trim();
			// One reply consumes the turn and everything the tool recorded for it.
			const addressedBy = room.pendingAddressedBy;
			const handOffRequested = room.pendingHandOff;
			const spokenInTool = room.pendingSpokenInTool === true;
			room.pendingAddressedBy = undefined;
			room.pendingHandOff = undefined;
			room.pendingSpokenInTool = undefined;

			// Whether to address the peer bot is a decision, not a default. `shouldHandOff` covers a
			// peer's message, which earns an answer; `handOffRequested` lets the agent stop (`false`)
			// or continue (`true`) either way. A human's message never forces an address: the room is
			// already open — `openConversation` posted an addressed greeting when the group was made —
			// and forwarding every question a person asks their own agent would interrupt the peer
			// for nothing. Addressing the peer on every reply is exactly how two bots talk forever.
			const eligible = addressedBy !== undefined && shouldHandOff(addressedBy);
			const wantsPeer = handOffRequested === undefined ? eligible : handOffRequested;

			if (wantsPeer) {
				if (peerTurns >= MAX_PEER_TURNS) {
					// Budget spent. Post whatever is unsaid, unaddressed, and stop the chain here.
					if (text && text !== room.lastSpokenText) void speak(text, undefined);
					room.exchangeOpen = false;
					room.ui?.notify(
						`room · 已连续接棒 ${MAX_PEER_TURNS} 轮，暂停自动转给对方（在群里 @ 机器人可继续）`,
						"info",
					);
					return;
				}
				// Count only a hand-off that actually happens, so the budget measures round-trips
				// rather than inbound messages.
				// `room_send` already counted and posted this turn's message, address included; posting
				// the assistant text again would duplicate it in the group.
				if (!spokenInTool) {
					peerTurns += 1;
					if (text && text !== room.lastSpokenText) void speak(text, room.peer?.openId);
				}
				return;
			}

			// No hand-off: the reply still reaches the room, but nobody is woken by it.
			if (!spokenInTool && text && text !== room.lastSpokenText) void speak(text, undefined);
			if (room.exchangeOpen && addressedBy === "bot") {
				// This side answered the peer and chose not to continue: the room now waits for a
				// human on either end, and saying so beats looking stuck.
				room.ui?.notify("room · 本轮已结束（本侧未继续交棒），在群里 @ 机器人可继续", "info");
			}
			room.exchangeOpen = false;
		});

		/**
		 * The only sanctioned way for this session to move data out of its machine: a short
		 * conclusion, optionally addressed to the peer bot. A repository's contents cannot leave
		 * through the room because they never leave the machine.
		 *
		 * The tool is registered once, at load, and stays in the tool block whether or not a room is
		 * open. Registering it on `/room` and removing it on `/room leave` would rewrite the tool
		 * block, and providers serialize `tools` ahead of the system prompt and messages: every
		 * enter and exit would invalidate the cached prefix for the whole conversation. Availability
		 * is therefore enforced here — a call outside a room is refused — which is the same split
		 * plan mode uses between its guard and its tool list.
		 */
		pi.registerTool({
			name: ROOM_TOOL,
			label: "Room message",
			description: [
				"Send a short conclusion to the room while you are in a StepCode room.",
				"Outside a room this tool does nothing: a room starts with /room and is joined with /room join <code>.",
				"Pass handOff: true only when the other agent still needs to act on what you wrote.",
				"If the matter is settled — you agree, nothing is left for them to do — omit handOff:",
				"the message is posted without addressing them and the exchange ends there.",
				"Say only what the other side cannot see on its own; never pass file contents or secrets.",
			].join(" "),
			parameters: {
				type: "object",
				properties: {
					summary: { type: "string", description: "The conclusion, a few sentences at most." },
					handOff: {
						type: "boolean",
						description: "Address the other agent so it continues. Omit when there is nothing left for it to do.",
					},
				},
				required: ["summary"],
			},
			execute: async (args: { summary: string; handOff?: boolean }) => {
				const current = room;
				// `chatId` is what makes a message deliverable: `/room` assigns the room before the
				// group exists, and `speak` cannot post without a chat. Reporting success in that
				// window would tell the agent it spoke when nothing was sent and nothing can be recalled.
				if (!current) {
					return { ok: false, error: "not in a room: run /room or /room join <code> first" };
				}
				if (!current.chatId) {
					return {
						ok: false,
						error: "room is not open yet: waiting for the other side to join and create the group",
					};
				}
				const summary = String(args.summary ?? "").slice(0, 2000);
				// The tool is the agent's own path to the peer, so the budget is enforced here as well;
				// otherwise every turn could call `room_send` and the cap would never apply.
				const mayHandOff = peerTurns < MAX_PEER_TURNS;
				const handOff = args.handOff === true && Boolean(current.peer?.openId) && mayHandOff;
				if (handOff) {
					peerTurns += 1;
				}
				// The tool posts the message itself, address included. Mark the turn as already spoken so
				// `message_end` neither repeats this text nor appends another address to it.
				current.pendingHandOff = handOff;
				current.pendingSpokenInTool = true;
				await speak(summary, handOff ? current.peer?.openId : undefined);
				if (args.handOff === true && !handOff) {
					// Name the condition that actually stopped the hand-off; the budget is only one.
					const reason = mayHandOff
						? "对方机器人还未知，暂时无法交给对方"
						: `本侧已到 ${MAX_PEER_TURNS} 轮接棒上限`;
					return { ok: true, note: `已发言但未转给对方：${reason}，等人在群里 @ 再继续` };
				}
				return { ok: true };
			},
		} as never);
	};
}

function credentialsOf(record: RoomAgentRecord): LarkCredentials {
	return { appId: record.appId, appSecret: record.appSecret, brand: record.brand };
}

/** Card shape kept minimal: one markdown block plus an optional setting line. */
function card(text: string, subtitle?: string): Record<string, unknown> {
	return {
		config: { wide_screen_mode: true, enable_forward: false },
		elements: [
			...(subtitle ? [{ tag: "div", text: { tag: "plain_text", content: subtitle } }] : []),
			{ tag: "div", text: { tag: "lark_md", content: text } },
		],
	};
}
