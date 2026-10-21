/**
 * `#modelMenu`: one panel for model and thinking effort, in two views
 * (legacy app.js 2558-2826, `populateModels` 2987-2990).
 *
 * They are chosen together — effort is a property of a model, and the kernel
 * only exposes the levels a given model supports — so splitting them into two
 * popovers meant guessing the effort before knowing the model.
 *
 * The default view stays short: a few models, the effort as a segmented
 * control, and a "more models" row. Search and pinning live behind that row,
 * because a catalog of five needs neither and a catalog of fifty needs both.
 */

import { useState } from "react";
import { useT } from "../../i18n";
import { shallowEqual, useAppStore } from "../../state/store";
import { selectEffort, selectModel } from "./actions";
import { ControlMenu } from "./ControlOption";
import { ModelPanel, type ModelPanelView } from "./ModelPanel";
import { draftModelSource, type ModelSource, modelLabelParts, readPinnedModels, togglePinnedModel } from "./models";
import type { ComposerMenuProps } from "./PolicyMenu";

export function ModelMenu({ open, onOpen, onClose }: ComposerMenuProps) {
	const t = useT();
	const current = useAppStore((state) => state.current);
	const draft = useAppStore(
		(state) => ({ models: state.draftModels, model: state.draftModel, effort: state.draftThinking }),
		shallowEqual,
	);
	const [view, setView] = useState<ModelPanelView>("compact");
	const [query, setQuery] = useState("");
	/** Bumped whenever legacy rebuilt (and refocused) the search field. */
	const [searchEpoch, setSearchEpoch] = useState(0);
	const [pinned, setPinned] = useState<readonly string[]>(readPinnedModels);
	// A draft paints the host's prediction for its first session, so the label
	// and panel show the model and effort that session will actually start on.
	const source: ModelSource = current ?? draftModelSource(draft.models, draft.model, draft.effort);

	const labelParts = source.model ? modelLabelParts(t, source) : undefined;

	const resetSearch = () => {
		setQuery("");
		setSearchEpoch((epoch) => epoch + 1);
	};

	return (
		<ControlMenu
			id="modelMenu"
			triggerId="modelTrigger"
			triggerClassName="model-control"
			title="模型与思考强度"
			icon="cube"
			labelId="modelLabel"
			// Before the draft's prediction arrives there is no model to name yet.
			// A long name is cut with an ellipsis instead of pushing the controls on
			// its left; the hover title and the panel still show it in full.
			label={
				labelParts ? (
					<>
						<span className="model-control-name" title={labelParts.name}>
							{labelParts.name}
						</span>
						{labelParts.effort}
					</>
				) : (
					"默认模型"
				)
			}
			popoverId="modelPopover"
			// The trigger sits at the composer's right edge and its width varies with the
			// name, so the panel lines up with its right edge rather than run past the window.
			placement="top-end"
			open={open}
			onOpen={() => {
				// Always open on the short view; "more models" is a deliberate step.
				setView("compact");
				setQuery("");
				setPinned(readPinnedModels());
				onOpen();
			}}
			onClose={onClose}
		>
			<ModelPanel
				source={source}
				view={view}
				query={query}
				searchEpoch={searchEpoch}
				pinned={pinned}
				onQuery={setQuery}
				onView={(next) => {
					setView(next);
					resetSearch();
				}}
				onPin={(key) => setPinned(togglePinnedModel(key))}
				onSelectModel={(value) => {
					// Applying a model repaints the panel rather than closing it, so the
					// effort list immediately reflects the model just chosen.
					void selectModel(value).then((applied) => {
						if (applied) resetSearch();
					});
				}}
				onSelectEffort={(level) => {
					void selectEffort(level).then((applied) => {
						if (applied) onClose();
					});
				}}
			/>
		</ControlMenu>
	);
}
