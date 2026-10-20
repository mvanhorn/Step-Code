import { Fragment, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useLocale, useT } from "../../i18n";
import { collectTurnChanges } from "../../lib/turn-changes";
import { setUi, useAppStore } from "../../state/store";
import type { SteeringMessage, TimelineItem } from "../../state/types";
import { MessageActions, MessageItem } from "./MessageItem";
import { RetryRow } from "./RetryRow";
import { ThinkingDisclosure } from "./ThinkingDisclosure";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { ApprovalCard, ToolRow } from "./TimelineRows";
import { TurnArtifacts } from "./TurnArtifacts";
import { TurnChangesCard } from "./TurnChangesCard";
import { turnArtifacts } from "./turn-artifacts";
import { collectTurnFooters } from "./turn-footers";

/** Shown while the timeline is empty (legacy index.html 835-842, `renderTimeline`). */
function EmptyConversation() {
	const t = useT();
	return (
		<div className="empty-state">
			<div className="empty-wordmark">
				<span>STEP</span>
				<strong>CODE</strong>
			</div>
			<p>{t("emptyConversation")}</p>
		</div>
	);
}

/**
 * React key of a timeline row. Item ids are unique in practice, but a live
 * `tool_execution_start` can repeat a tool already in the snapshot, so a
 * repeated id gets its position appended instead of colliding.
 */
function itemKeys(items: readonly TimelineItem[]): string[] {
	const seen = new Set<string>();
	return items.map((item, index) => {
		if (!seen.has(item.itemId)) {
			seen.add(item.itemId);
			return item.itemId;
		}
		return `${item.itemId}#${index}`;
	});
}

/**
 * Whether a running turn is between visible steps: right after the prompt, or
 * after a tool finished and before the model's next output. A streaming reply,
 * a running tool or an approval card already shows what is going on.
 */
function awaitingOutput(items: readonly TimelineItem[]): boolean {
	const last = items.at(-1);
	if (!last) return true;
	if (last.kind === "message") return last.role === "user";
	if (last.kind === "tool") return last.state !== "pending";
	// A retry under way shows its own status.
	if (last.kind === "retry") return !last.live;
	return false;
}

function scrollToEnd(stream: HTMLElement | null): void {
	if (stream) stream.scrollTop = stream.scrollHeight;
}

const NO_STEERING: readonly SteeringMessage[] = [];

/** Within this many pixels of the end the stream counts as "at the bottom" and follows new output. */
const STICK_THRESHOLD = 48;

/**
 * `#stream > #streamInner`: the session timeline (legacy `renderTimeline`,
 * app.js 2246-2281). New output keeps the view pinned to the bottom only while
 * the reader is there: scrolling up during a turn leaves the view alone.
 * Opening a session or sending a message pins it again.
 */
export function ConversationStream() {
	const items = useAppStore((state) => state.timelineItems);
	const pendingTurn = useAppStore((state) => state.pendingTurn);
	// Sent with "立即" or Cmd/Ctrl+Enter: the kernel reads them after the current tool call; shown already.
	const steering = useAppStore((state) => state.current?.steeringMessages ?? NO_STEERING);
	const sessionId = useAppStore((state) => state.current?.id ?? "");
	const cwd = useAppStore((state) => state.current?.cwd ?? "");
	const status = useAppStore((state) => state.current?.status);
	const revertedTurns = useAppStore((state) => state.current?.revertedTurns);
	const reveal = useAppStore((state) => state.ui.revealEntry);
	const running = status === "running";
	const busy = running || status === "waiting";
	const locale = useLocale();
	const streamRef = useRef<HTMLDivElement>(null);
	const innerRef = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const keys = itemKeys(items);
	const turns = useMemo(() => collectTurnChanges(items, cwd), [items, cwd]);
	const footerAfter = useMemo(
		() => new Map(collectTurnFooters(items, status, pendingTurn !== null).map((turn) => [turn.lastIndex, turn])),
		[items, status, pendingTurn],
	);
	const artifactsAfter = useMemo(
		() => new Map([...footerAfter].map(([index, footer]) => [index, turnArtifacts(items, footer, cwd)])),
		[footerAfter, items, cwd],
	);

	// A new session or a sent message: follow the bottom again.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the session id and the pending messages are the triggers.
	useLayoutEffect(() => {
		stick.current = true;
		scrollToEnd(streamRef.current);
	}, [sessionId, pendingTurn, steering.length]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: items and locale change the content height.
	useLayoutEffect(() => {
		if (stick.current) scrollToEnd(streamRef.current);
	}, [items, locale]);
	// A search hit: once its session's timeline is drawn, centre the entry and stop following the end.
	useLayoutEffect(() => {
		if (!reveal || reveal.sessionId !== sessionId || !items.length) return;
		setUi({ revealEntry: null });
		const target = innerRef.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(reveal.entryId)}"]`);
		if (!target) return;
		stick.current = false;
		target.scrollIntoView({ block: "center" });
		target.animate([{ backgroundColor: "var(--selection)" }, { backgroundColor: "transparent" }], {
			duration: 1600,
			easing: "ease-out",
		});
	}, [reveal, sessionId, items]);
	// The live reply grows between store updates (smooth reveal), so watch the size too.
	useEffect(() => {
		const inner = innerRef.current;
		if (!inner) return;
		const observer = new ResizeObserver(() => {
			if (stick.current) scrollToEnd(streamRef.current);
		});
		observer.observe(inner);
		return () => observer.disconnect();
	}, []);
	const onScroll = () => {
		const stream = streamRef.current;
		if (stream) stick.current = stream.scrollHeight - stream.scrollTop - stream.clientHeight < STICK_THRESHOLD;
	};

	// A pending message is drawn after the timeline, so the indicator follows it.
	const thinking = pendingTurn !== null || (running && awaitingOutput(items));
	const cardAfter = new Map(
		turns
			.filter((turn) => !turn.latest || pendingTurn !== null || !busy)
			.map((turn) => [turn.lastIndex, turn] as const),
	);
	return (
		<div className="stream" id="stream" ref={streamRef} onScroll={onScroll}>
			<div className="stream-inner" id="streamInner" ref={innerRef}>
				{items.length || pendingTurn || steering.length ? (
					<>
						{items.map((item, index) => {
							const card = cardAfter.get(index);
							const footer = footerAfter.get(index);
							// Always a fragment, so a card appearing under a row does not remount the row.
							return (
								<Fragment key={keys[index]}>
									{item.kind === "message" ? (
										<MessageItem item={item} />
									) : item.kind === "tool" ? (
										<ToolRow item={item} />
									) : item.kind === "thinking" ? (
										<ThinkingDisclosure item={item} active={running} />
									) : item.kind === "retry" ? (
										<RetryRow item={item} />
									) : (
										<ApprovalCard approval={item.approval} />
									)}
									{footer ? (
										<TurnArtifacts
											key={`outputs-${sessionId}-${footer.turnId}`}
											artifacts={artifactsAfter.get(index) ?? []}
											cwd={cwd}
										/>
									) : null}
									{card ? (
										<TurnChangesCard turn={card} reverted={Boolean(revertedTurns?.includes(card.turnId))} />
									) : null}
									{footer ? <MessageActions key={footer.turnId} messages={footer.messages} /> : null}
								</Fragment>
							);
						})}
						{steering.map((message, index) => (
							<MessageItem
								// Kernel texts carry no id; equal texts are interchangeable here.
								// biome-ignore lint/suspicious/noArrayIndexKey: see above.
								key={`steering-${index}`}
								item={{
									itemId: `message-steering-${index}`,
									kind: "message",
									role: "user",
									content: message.text,
									images: message.images.map((image) => `data:${image.mimeType};base64,${image.data}`),
								}}
							/>
						))}
						{pendingTurn ? (
							<MessageItem
								item={{
									itemId: "message-pending",
									kind: "message",
									role: "user",
									content: pendingTurn.text,
									images: pendingTurn.images,
								}}
								files={pendingTurn.files}
							/>
						) : null}
						{thinking ? <ThinkingIndicator /> : null}
					</>
				) : (
					<EmptyConversation />
				)}
			</div>
		</div>
	);
}
