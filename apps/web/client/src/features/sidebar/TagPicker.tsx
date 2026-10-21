import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { TAG_COLOR_NAMES, type TagColor, useT } from "../../i18n";
import { useImeGuard } from "../../lib/ime";
import { getState, shallowEqual, useAppStore } from "../../state/store";
import { closeTagPicker, createGroupAndTag, setSessionTag } from "./actions";
import { cssVar, TAG_COLOR_KEYS, TAG_COLORS } from "./tags";

/** The "name the new group" row (legacy `showTagNameInput`, 1062-1080). */
function TagNameInput({ sessionId, color }: { readonly sessionId: string; readonly color: TagColor }) {
	const t = useT();
	const input = useRef<HTMLInputElement>(null);
	const ime = useImeGuard();
	useEffect(() => input.current?.focus(), []);
	const accept = () => {
		const fallback = TAG_COLOR_NAMES[getState().locale][color];
		createGroupAndTag(sessionId, color, input.current?.value.trim() || fallback);
		closeTagPicker();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		// Keeps the document shortcuts (and the Escape chain) out of the name field.
		event.stopPropagation();
		if (event.key === "Enter" && !ime.isComposing(event)) accept();
		if (event.key === "Escape") closeTagPicker();
	};
	return (
		<div className="tag-create">
			<span className="tag-diamond" style={cssVar("--tag-color", TAG_COLORS[color])} />
			<input
				ref={input}
				id="tagNameInput"
				maxLength={12}
				placeholder={t("groupNamePlaceholder")}
				{...ime.handlers}
				onKeyDown={onKeyDown}
			/>
			<button type="button" id="tagNameConfirm" onClick={accept}>
				{t("confirm")}
			</button>
		</div>
	);
}

/**
 * Content of `#tagPicker`: choose, create or clear a session's group (legacy
 * `openTagPicker`, 1014-1060). Mounted on open, so every open starts from the group list.
 */
export function TagPicker({ sessionId }: { readonly sessionId: string }) {
	const t = useT();
	const data = useAppStore((state) => ({ groups: state.groups, tags: state.tags }), shallowEqual);
	const [creating, setCreating] = useState<TagColor | null>(null);
	if (creating) return <TagNameInput sessionId={sessionId} color={creating} />;

	const used = new Set(data.groups.map((group) => group.key));
	const fresh = TAG_COLOR_KEYS.filter((color) => !used.has(color));
	const choose = (tag: TagColor | "") => {
		if (!tag || data.tags.get(sessionId) === tag) setSessionTag(sessionId, null);
		else setSessionTag(sessionId, tag);
		closeTagPicker();
	};
	return (
		<>
			{data.groups.map((group) => (
				<button key={group.key} type="button" data-tag={group.key} onClick={() => choose(group.key)}>
					<span className="tag-diamond" style={cssVar("--tag-color", TAG_COLORS[group.key])} />
					<span>{group.name}</span>
				</button>
			))}
			{fresh.length ? (
				<>
					<div className="tag-picker-caption">{t("createGroup")}</div>
					{fresh.map((color) => (
						<button key={color} type="button" data-new-tag={color} onClick={() => setCreating(color)}>
							<span className="tag-diamond" style={cssVar("--tag-color", TAG_COLORS[color])} />
							<span>{t("useColor")}</span>
						</button>
					))}
				</>
			) : null}
			<div className="tag-picker-divider" />
			<button type="button" data-tag="" onClick={() => choose("")}>
				<span className="tag-diamond" />
				<span>{t("noCategory")}</span>
			</button>
		</>
	);
}
