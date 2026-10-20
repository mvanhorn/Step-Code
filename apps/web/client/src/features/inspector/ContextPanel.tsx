import { useMemo, useState } from "react";
import { useT } from "../../i18n";
import { copyText } from "../../state/session";
import { useAppStore } from "../../state/store";
import type { SessionEntry, SessionInspector } from "../../state/types";
import { Icon, IconButton, Tooltip } from "../../ui";
import { finiteAmount, messagePreview, recordedMessage } from "./model";

const CAPACITY_TICKS = Array.from({ length: 40 }, (_, index) => index);

function MessageJson({ entry }: { readonly entry: SessionEntry }) {
	const t = useT();
	const json = useMemo(() => JSON.stringify(recordedMessage(entry), null, 2), [entry]);
	return (
		<div className="context-json">
			<div>
				<span>JSON</span>
				<Tooltip content={t("copy")}>
					<IconButton icon="copy" aria-label={t("copy")} onClick={() => void copyText(json ?? "")} />
				</Tooltip>
			</div>
			<pre>{json}</pre>
		</div>
	);
}

function MessageRow({ entry }: { readonly entry: SessionEntry }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const role = entry.message?.role ?? "custom";
	const roleKey = `rightRole.${role}`;
	return (
		<details className="context-message" onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary>
				<span className="context-message-role">{t(roleKey) === roleKey ? role : t(roleKey)}</span>
				<span>{messagePreview(entry).slice(0, 180) || entry.type}</span>
				<Icon name="chevronRight" size="xs" />
			</summary>
			{open ? <MessageJson entry={entry} /> : null}
		</details>
	);
}

export function ContextPanel({ data }: { readonly data?: SessionInspector }) {
	const t = useT();
	const current = useAppStore((state) => state.current);
	const [filter, setFilter] = useState("all");
	const entries = current?.entries ?? [];
	const messages = useMemo(() => entries.filter((entry) => Boolean(entry.message)), [entries]);
	const rows = messages.filter((entry) => filter === "all" || entry.message?.role === filter);
	const last = [...messages].reverse().find((entry) => entry.message?.role === "assistant" && entry.message.usage);
	const usage = last?.message?.usage;
	const percent = finiteAmount(data?.stats.contextUsage?.percent);
	const format = (value: unknown) => finiteAmount(value)?.toLocaleString() ?? "--";
	const input = finiteAmount(usage?.input);
	const cacheRead = finiteAmount(usage?.cacheRead);
	const cacheWrite = finiteAmount(usage?.cacheWrite);
	const prompt =
		input !== undefined && cacheRead !== undefined && cacheWrite !== undefined
			? input + cacheRead + cacheWrite
			: undefined;
	return (
		<div className="context-content">
			<div className="context-identity">
				<strong>{current?.name || t("newConversation")}</strong>
				<span>{current?.model?.id ?? "--"}</span>
				<small>{current?.model?.provider ?? "--"}</small>
			</div>
			<section className="context-capacity">
				<div className="context-section-title">
					<h3>{t("rightContextUsage")}</h3>
					<span>{t("rightEstimated")}</span>
				</div>
				<div className="context-capacity-number">
					<strong>
						{percent?.toFixed(1) ?? "--"}
						<small>%</small>
					</strong>
					<span>
						{format(data?.stats.contextUsage?.tokens)} / {format(data?.stats.contextUsage?.contextWindow)}
					</span>
				</div>
				{/* biome-ignore lint/a11y/useSemanticElements: the segmented meter supports an unknown value without inventing a native meter's default zero. */}
				<div
					className="context-capacity-strip"
					role="meter"
					aria-label={t("rightContextUsage")}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={percent === undefined ? undefined : Math.min(100, percent)}
					aria-valuetext={percent === undefined ? t("rightUnknown") : `${percent.toFixed(1)}%`}
				>
					{CAPACITY_TICKS.map((tick) => (
						<i key={tick} className={percent !== undefined && tick < percent / 2.5 ? "is-used" : ""} />
					))}
				</div>
			</section>
			<section className="context-session-totals">
				<div>
					<span>{t("rightTotalTokens")}</span>
					<strong>
						{format(data?.stats.tokens.total)}
						<small> tok</small>
					</strong>
				</div>
				<div>
					<span>{t("rightCost")}</span>
					<strong>
						{finiteAmount(data?.stats.cost) === undefined ? "--" : `$${data?.stats.cost.toFixed(4)}`}
					</strong>
				</div>
			</section>
			<section>
				<div className="context-section-title">
					<h3>{t("rightLatestResponse")}</h3>
				</div>
				<dl className="context-usage-list">
					{(["input", "cacheRead", "cacheWrite", "output", "reasoning"] as const).map((name) => (
						<div key={name}>
							<dt>{t(`rightUsage.${name}`)}</dt>
							<dd>{format(usage?.[name])}</dd>
						</div>
					))}
					<div>
						<dt>{t("rightCacheHit")}</dt>
						<dd>{prompt && cacheRead !== undefined ? `${((cacheRead / prompt) * 100).toFixed(1)}%` : "--"}</dd>
					</div>
				</dl>
			</section>
			<section>
				<div className="context-section-title">
					<h3>{t("rightRecordedMessages")}</h3>
					<span>{messages.length}</span>
				</div>
				<fieldset className="context-message-tabs" aria-label={t("rightMessageRoles")}>
					{["all", "user", "assistant", "toolResult"].map((role) => (
						<button type="button" key={role} aria-pressed={filter === role} onClick={() => setFilter(role)}>
							{t(`rightRole.${role}`)}
							<small>
								{role === "all"
									? messages.length
									: messages.filter((entry) => entry.message?.role === role).length}
							</small>
						</button>
					))}
				</fieldset>
				{[...rows].reverse().map((entry) => (
					<MessageRow entry={entry} key={entry.id} />
				))}
				{!rows.length ? <p className="sb-state">{t("rightNoMessages")}</p> : null}
			</section>
		</div>
	);
}
