/**
 * Live Feishu wiring for `/room`.
 *
 * Two adapters, nothing else: authorization turns this person's browser consent into a room bot's
 * credentials, and the transport wraps `LarkTransport` + `LarkApi` behind the small `RoomTransport`
 * surface the command uses. Keeping them here means the command stays testable without a tenant.
 */

import type { ExtensionContext } from "@step-harness/coding-agent";
import { LarkApi, type LarkCredentials, LarkRegistration, LarkTransport } from "@step-harness/lark-adapter";
import { createLarkPairingView, type LarkPairingCopy } from "../view/dialogs/lark-pairing.ts";
import type { RoomInbound, RoomTransport } from "./room-connection.ts";

/** Kept apart from `/connect`'s widget so the two consent flows never overwrite each other. */
const PAIRING_WIDGET = "room-pairing";

/**
 * The room flow creates and keeps a bot, which `/connect`'s copy does not describe: it says the
 * credentials live only in memory, while a room bot's are written to `lark/room-agent.json` so the
 * next `/room` reuses the same application instead of creating another one.
 */
const ROOM_PAIRING_COPY: LarkPairingCopy = {
	heading: "room · 扫码或打开下面的链接，创建一个给会议室用的机器人：",
	storage: "凭据保存在本机的 lark/room-agent.json（仅本人可读），下次 /room 复用同一个机器人。",
	cancel: "已授权后中途按 Esc 不会删除刚创建的应用，可在飞书后台清理。",
};

/** Device-code consent: the person scans a QR, the credentials arrive in memory and nowhere else. */
export async function authorizeRoomBot(
	context: ExtensionContext,
): Promise<{ credentials: LarkCredentials; ownerOpenId: string } | undefined> {
	const controller = new AbortController();
	const registration = new LarkRegistration({ version: "room" });
	try {
		const code = await registration.begin(controller.signal);
		const pairing = await createLarkPairingView(code, () => process.stdout.rows || 40, ROOM_PAIRING_COPY);
		context.ui.setWidget(PAIRING_WIDGET, () => pairing);
		context.ui.notify(`room · 扫码或打开链接创建机器人：${code.verificationUrl}`, "info");
		const result = await registration.waitForAuthorization(code, controller.signal);
		if (result.status !== "authorized") {
			context.ui.notify(
				result.status === "expired" ? "room · 授权已过期，请重试 /room" : "room · 授权被拒绝",
				"warning",
			);
			return undefined;
		}
		// The consenting person, not their bot, owns the room's group. Without their open id the group
		// would have to be owned by a machine, which Feishu does not allow for a private group.
		const ownerOpenId = result.userInfo?.openId;
		if (!ownerOpenId) {
			context.ui.notify("room · 授权未返回你的身份，无法建群", "warning");
			return undefined;
		}
		return {
			credentials: result.credentials,
			ownerOpenId,
			...(result.userInfo?.unionId ? { ownerUnionId: result.userInfo.unionId } : {}),
		};
	} catch {
		context.ui.notify("room · 授权过程失败，请重试 /room", "warning");
		return undefined;
	} finally {
		// The QR is a one-shot prompt: leaving it behind would keep a dead link on screen.
		context.ui.setWidget(PAIRING_WIDGET, undefined);
	}
}

/**
 * Build the live transport. The group is always created by app identity with an explicit bot list,
 * which is why this adapter exposes the creation call the command expects rather than re-deriving it.
 */
export function liveRoomTransport(
	credentials: LarkCredentials,
	onMessage: (message: RoomInbound) => void,
	onBotAdded?: (chatId: string) => void,
): RoomTransport {
	const api = new LarkApi(credentials);
	let transport: LarkTransport | undefined;
	let botId = "";
	return {
		async start() {
			const identity = await api.getBotIdentity();
			botId = identity.openId;
			transport = new LarkTransport({
				credentials,
				botId,
				onMessage: (message) => {
					onMessage({
						chatId: message.chatId,
						messageId: message.id,
						createdAt: message.createdAt,
						text: message.text,
						...(message.senderType ? { senderType: message.senderType } : {}),
						...(message.senderOpenId ? { senderOpenId: message.senderOpenId } : {}),
						mentions: message.mentions,
					});
				},
				onCardAction: () => undefined,
				onState: () => undefined,
				...(onBotAdded ? { onBotAdded } : {}),
			});
			await transport.start();
		},
		close() {
			transport?.close();
		},
		async identity() {
			const identity = await api.getBotIdentity();
			botId = identity.openId;
			return identity;
		},
		createChat(input) {
			return api.createChat({
				name: input.name,
				...(input.userIds
					? { userIdType: input.userIdType ?? "open_id", userIds: input.userIds }
					: { userOpenIds: input.userOpenIds }),
				botIds: input.botIds,
				...(input.ownerOpenId ? { ownerOpenId: input.ownerOpenId } : {}),
				dedupeKey: input.dedupeKey,
			});
		},
		api: {
			sendText: (chatId, text, replyTo) => api.sendText(chatId, text, replyTo),
			sendCard: (chatId, card, replyTo) => api.sendCard(chatId, card, replyTo),
			updateCard: (messageId, card) => api.updateCard(messageId, card),
			listChatMembers: (chatId) => api.listChatMembers(chatId),
			addMembers: (chatId, ids, idType) => api.addChatMembers(chatId, ids, idType),
			close: () => api.close(),
		},
	};
}
