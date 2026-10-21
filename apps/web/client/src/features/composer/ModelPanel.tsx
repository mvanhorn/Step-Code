/** Body of `#modelPopover` (legacy `renderModelPicker`, app.js 2606-2807). */

import { type ReactNode, useEffect, useRef } from "react";
import { useT } from "../../i18n";
import { modelKey } from "../../state/session";
import type { ModelInfo } from "../../state/types";
import { Icon, SearchInput, SegmentedControl } from "../../ui";
import { ControlOption, PopoverGroupLabel, PopoverHint, PopoverNote } from "./ControlOption";
import {
	COMPACT_MODEL_COUNT,
	compactCandidates,
	effortLabel,
	filterModels,
	type ModelSource,
	modelMeta,
} from "./models";

export type ModelPanelView = "compact" | "all";

export interface ModelPanelProps {
	readonly source: ModelSource;
	readonly view: ModelPanelView;
	readonly query: string;
	/** Changes whenever the search field should be emptied and refocused. */
	readonly searchEpoch: number;
	readonly pinned: readonly string[];
	readonly onQuery: (query: string) => void;
	readonly onView: (view: ModelPanelView) => void;
	readonly onPin: (key: string) => void;
	readonly onSelectModel: (value: string) => void;
	readonly onSelectEffort: (level: string) => void;
}

export function ModelPanel(props: ModelPanelProps) {
	const { source, view, query, searchEpoch, pinned, onQuery, onView, onPin, onSelectModel, onSelectEffort } = props;
	const t = useT();
	const models = source.models ?? [];
	const levels = source.availableThinkingLevels ?? [];
	const currentKey = source.model ? modelKey(source.model) : "";
	const active = models.find((model) => modelKey(model) === currentKey);
	const effort = source.thinkingLevel;
	const all = view === "all";
	const candidates = all ? filterModels(models, query) : compactCandidates(models, pinned, active);
	return (
		<>
			{all ? <ModelSearch key={searchEpoch} query={query} onQuery={onQuery} /> : null}
			{/* Only the rows scroll, so the search above and the controls below stay in view. */}
			<div className="model-popover-list">
				<ModelRows
					candidates={candidates}
					pinned={pinned}
					currentKey={currentKey}
					pinnable={all}
					onPin={onPin}
					onSelect={onSelectModel}
				/>
			</div>
			{all ? (
				<MoreButton onClick={() => onView("compact")}>
					<Icon name="chevronLeft" size="sm" />
					<span>{t("backToModels")}</span>
				</MoreButton>
			) : models.length > COMPACT_MODEL_COUNT ? (
				<MoreButton onClick={() => onView("all")}>
					<Icon name="layers" size="sm" />
					<span>{t("moreModels")}</span>
					<Icon name="chevronRight" size="sm" />
				</MoreButton>
			) : null}
			<div className="control-popover-section">
				<span className="control-segmented-label">{t("thinkingEffort")}</span>
				{levels.length ? (
					<SegmentedControl
						bare
						className="control-segmented-group"
						role="group"
						aria-label={t("thinkingEffort")}
						itemClassName="control-segment"
						items={levels.map((level) => ({ value: level, label: effortLabel(t, level) }))}
						value={effort ?? null}
						onChange={onSelectEffort}
					/>
				) : (
					// biome-ignore lint/a11y/useSemanticElements: legacy markup is div[role=group]; a <fieldset> brings its own border and padding.
					<div className="control-segmented-group" role="group" aria-label={t("thinkingEffort")}>
						{/* No levels means the model cannot adjust effort at all; say so rather than an empty row. */}
						<span className="control-segment-none">{t("effortUnsupported")}</span>
					</div>
				)}
			</div>
			{all ? null : <PopoverNote>{t("modelSwitchHint")}</PopoverNote>}
		</>
	);
}

/** The "more models" / "back" row, right under the model list so it never scrolls out of reach. */
function MoreButton({ onClick, children }: { readonly onClick: () => void; readonly children: ReactNode }) {
	return (
		<button type="button" className="control-popover-more" onClick={onClick}>
			{children}
		</button>
	);
}

/** `.control-popover-search`, focused on the frame after it appears (legacy `requestAnimationFrame`). */
function ModelSearch({ query, onQuery }: { readonly query: string; readonly onQuery: (query: string) => void }) {
	const t = useT();
	const input = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		const frame = requestAnimationFrame(() => input.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, []);
	return (
		<SearchInput
			bare
			ref={input}
			wrapperClassName="control-popover-search"
			iconSize="sm"
			placeholder={t("searchModels")}
			aria-label={t("searchModels")}
			value={query}
			onChange={(event) => onQuery(event.target.value)}
		/>
	);
}

interface ModelRowsProps {
	readonly candidates: readonly ModelInfo[];
	readonly pinned: readonly string[];
	readonly currentKey: string;
	readonly pinnable: boolean;
	readonly onPin: (key: string) => void;
	readonly onSelect: (value: string) => void;
}

/** Model rows for one set of candidates; an "other models" heading precedes the first unpinned one. */
function ModelRows({ candidates, pinned, currentKey, pinnable, onPin, onSelect }: ModelRowsProps) {
	const t = useT();
	if (!candidates.length) return <PopoverHint>{t("noModels")}</PopoverHint>;
	const rows: ReactNode[] = [];
	let othersLabelled = false;
	for (const model of candidates) {
		const key = modelKey(model);
		if (!othersLabelled && !pinned.includes(key)) {
			rows.push(<PopoverGroupLabel key="others-label">{t("others")}</PopoverGroupLabel>);
			othersLabelled = true;
		}
		rows.push(
			<ControlOption
				key={key}
				id={key}
				icon="cube"
				title={model.name || model.id}
				description={model.id}
				meta={modelMeta(model)}
				selected={key === currentKey}
				pinned={pinnable ? pinned.includes(key) : false}
				onPin={pinnable ? () => onPin(key) : undefined}
				onSelect={onSelect}
			/>,
		);
	}
	return rows;
}
