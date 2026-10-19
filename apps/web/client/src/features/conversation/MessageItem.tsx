import { memo, useMemo, useRef, useState } from "react";
import { formatRelativeTime, useT } from "../../i18n";
import { type AttachedFile, FILE_MARKER, markAttachedFiles, splitAttachedFiles } from "../../lib/attached-files";
import { formatBytes, formatTokens } from "../../lib/format";
import { escapeHtml, renderMarkdown, skillInvocation } from "../../lib/markdown";
import { copyText } from "../../state/session";
import { setUi } from "../../state/store";
import type { MessageTimelineItem } from "../../state/types";
import { Icon, LEGACY_ICONS, MarkdownView } from "../../ui";
import { forkAtEntry } from "./actions";
import { openFeedback, type Sentiment } from "./feedback";
import { useFadeIn, useSmoothText } from "./streaming";
import { ThinkingIndicator } from "./ThinkingIndicator";

/** Same markup as the composer's chip (`prompt-editor.ts` `createChip`), so a sent message reads like its draft. */
function fileChipHtml(file: AttachedFile | undefined): string {
	if (!file) return "";
	const title = escapeHtml(`${file.path} · ${formatBytes(file.bytes)}`);
	return `<span class="message-file" title="${title}"><svg class="icon icon--xs" aria-hidden="true"><use href="#i-fileText"></use></svg><span>${escapeHtml(file.name)}</span></span>`;
}

/**
 * One chat message (legacy `renderTimeline` message branch, app.js 2253-2261).
 * `data-content` and `data-entry-id` are kept from the legacy markup.
 */
export const MessageItem = memo(function MessageItem({
	item,
	files: pendingFiles,
	readOnly = false,
}: {
	readonly item: MessageTimelineItem;
	/** The pending bubble's files: the host has not echoed the message (and its file blocks) yet. */
	readonly files?: readonly AttachedFile[];
	/** A child agent's transcript: no voting or forking, which act on the current session. */
	readonly readOnly?: boolean;
}) {
	const t = useT();
	const role = item.role === "user" ? "user" : "assistant";
	const live = item.itemId === "message-live";
	const codeLabel = t("code");
	const copyLabel = t("copy");
	const bodyRef = useRef<HTMLDivElement>(null);
	// Pasted or dropped files arrive as blocks after the user's text; the bubble shows them as inline chips where the user put them.
	const attached = useMemo(
		() => (role === "user" ? splitAttachedFiles(item.content) : { text: item.content, files: [] }),
		[role, item.content],
	);
	const skill = role === "user" ? skillInvocation(attached.text) : null;
	const content = useSmoothText(skill ? skill.request : attached.text, live);
	const images = role === "user" ? (item.images ?? []) : [];
	// Memoised: a streaming turn re-renders the timeline per frame, and parsing every earlier message each time made long sessions crawl.
	const files = pendingFiles ?? attached.files;
	const html = useMemo(() => {
		if (!files.length) return renderMarkdown(content, { code: codeLabel, copy: copyLabel });
		return renderMarkdown(markAttachedFiles(content, files), { code: codeLabel, copy: copyLabel }).replace(
			FILE_MARKER,
			(_match, index: string) => fileChipHtml(files[Number(index)]),
		);
	}, [content, files, codeLabel, copyLabel]);
	useFadeIn(bodyRef, html, live);
	if (item.error) return <MessageError entryId={item.entryId} error={item.error} />;
	// The live turn before its first text (reasoning, or waiting on the first token).
	if (role === "assistant" && !content) return <ThinkingIndicator />;
	return (
		<article className={`message ${role}`} data-content={item.content || ""} data-entry-id={item.entryId}>
			{skill ? (
				<span className="message-skill" title={skill.name}>
					<Icon name="cube" size="xs" />
					{skill.name}
				</span>
			) : null}
			{/* A user message can be images only; it still opens a turn, so it gets a row. */}
			{images.length ? <MessageImages images={images} /> : null}
			{content ? (
				<MarkdownView
					ref={bodyRef}
					className="message-body"
					html={html}
					onCopyCode={(code) => void copyText(code)}
				/>
			) : null}
			{item.role === "assistant" && !readOnly ? <MessageActions item={item} /> : null}
		</article>
	);
});

/** A user message's images as thumbnails; clicking one opens `#imagePreview`. */
function MessageImages({ images }: { readonly images: readonly string[] }) {
	const t = useT();
	return (
		<div className="message-images">
			{images.map((src, index) => {
				const name = t("imageNumbered", { index: index + 1 });
				return (
					<button
						// biome-ignore lint/suspicious/noArrayIndexKey: a message's images never reorder.
						key={index}
						type="button"
						className="message-image"
						aria-label={t("previewImageNamed", { name })}
						onClick={() => setUi({ imagePreview: { src, name } })}
					>
						<img src={src} alt="" />
					</button>
				);
			})}
		</div>
	);
}

/** `403: {"message": "..."}` -> the status and the provider's message; anything else unchanged. */
function errorDetail(error: string): { readonly status: string; readonly message: string } {
	const match = /^(\d{3}):\s*(\{[\s\S]*\})\s*$/.exec(error);
	if (!match) return { status: "", message: error };
	try {
		const body = JSON.parse(match[2]) as { message?: unknown; error?: { message?: unknown } };
		const message = body.message ?? body.error?.message;
		return { status: match[1], message: typeof message === "string" ? message : error };
	} catch {
		return { status: "", message: error };
	}
}

/** A failed model request: the provider's message, with any URL in it as a link (e.g. account verification). */
function MessageError({ entryId, error }: { readonly entryId?: string; readonly error: string }) {
	const t = useT();
	const detail = errorDetail(error);
	const parts = detail.message.split(/(https?:\/\/[^\s"'<>)]*[^\s"'<>),.;:!?])/g);
	return (
		<article className="message assistant message-error" role="alert" data-entry-id={entryId}>
			<div className="message-error-title">
				{t("modelRequestFailed")}
				{detail.status ? <span className="message-error-status">{detail.status}</span> : null}
			</div>
			<p className="message-error-text">
				{parts.map((part, index) =>
					index % 2 ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string.
						<a key={index} href={part} target="_blank" rel="noreferrer">
							{part}
						</a>
					) : (
						part
					),
				)}
			</p>
		</article>
	);
}

/**
 * The row under an assistant turn: copy, vote, fork, then what the turn cost and
 * when it happened (legacy `messageActions` + `wireMessageActions`, 2206-2302).
 *
 * Voting opens the feedback dialog rather than firing a silent request — a
 * thumbs-down with no detail is much less useful than one with a topic.
 */
function MessageActions({ item }: { readonly item: MessageTimelineItem }) {
	const t = useT();
	const [vote, setVote] = useState<Sentiment | null>(null);
	const tokens = item.usage ? item.usage.input + item.usage.output : 0;
	const onVote = (sentiment: Sentiment) => {
		// One vote visible at a time; clicking the active one clears it.
		setVote((already) => (already === sentiment ? null : sentiment));
		openFeedback(sentiment);
	};
	return (
		<div className="message-actions">
			<button
				className="message-action copy-message"
				type="button"
				title={t("copy")}
				aria-label={t("copy")}
				onClick={() => void copyText(item.content || "")}
			>
				<Icon {...LEGACY_ICONS.copy} />
			</button>
			<button
				className="message-action vote-up"
				type="button"
				aria-pressed={vote === "up"}
				title={t("feedbackGood")}
				aria-label={t("feedbackGood")}
				onClick={() => onVote("up")}
			>
				<Icon name="thumbsUp" size="sm" />
			</button>
			<button
				className="message-action vote-down"
				type="button"
				aria-pressed={vote === "down"}
				title={t("feedbackBad")}
				aria-label={t("feedbackBad")}
				onClick={() => onVote("down")}
			>
				<Icon name="thumbsDown" size="sm" />
			</button>
			<button
				className="message-action fork-message"
				type="button"
				title={t("forkHere")}
				aria-label={t("forkHere")}
				onClick={() => void forkAtEntry(item.entryId)}
			>
				<Icon name="fork" size="sm" />
			</button>
			{tokens ? (
				<span className="message-usage">
					<Icon name="gauge" size="xs" />
					{`${t("usage")} ${formatTokens(tokens)} tok`}
				</span>
			) : null}
			{item.timestamp ? <span className="message-time">{formatRelativeTime(item.timestamp)}</span> : null}
		</div>
	);
}
