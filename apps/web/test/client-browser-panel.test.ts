import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { closePreviewTab, showPreviewFiles } from "../client/src/features/files/actions.ts";
import { activeRightPanel, closeRightPanel, openRightPanel } from "../client/src/state/right-panel.ts";
import { createInitialState, getState, setState, setUi } from "../client/src/state/store.ts";

afterEach(() => setState(createInitialState()));

test("browser uses the shared exclusive inspector without discarding retained file tabs", () => {
	setState(createInitialState());
	setState((state) => ({
		preview: { ...state.preview, active: 0, tabs: [
			{ cwd: "/fixture", path: "notes.md", file: null, rendered: true, loading: false, error: "" },
		] },
	}));
	showPreviewFiles();
	openRightPanel("browser");
	assert.equal(activeRightPanel(getState()), "browser");
	assert.equal(getState().preview.open, false);
	assert.equal(getState().preview.tabs.length, 1);
	closePreviewTab(0);
	assert.equal(activeRightPanel(getState()), "browser");
	setUi({ rightPanelExpanded: true });
	closeRightPanel();
	assert.equal(activeRightPanel(getState()), null);
	assert.equal(getState().ui.rightPanelExpanded, false);
});

test("opening another inspector only changes presentation, not conversation selection", () => {
	setState({ ...createInitialState(), current: { id: "parent", cwd: "/fixture", status: "running" } });
	openRightPanel("browser");
	openRightPanel("context");
	assert.equal(activeRightPanel(getState()), "context");
	assert.equal(getState().current?.id, "parent");
	assert.equal(getState().current?.status, "running");
});
