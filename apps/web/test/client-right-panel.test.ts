import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { activeRightPanel, closeRightPanel, openRightPanel, toggleRightPanel } from "../client/src/state/right-panel.ts";
import { createInitialState, getState, setState, setUi } from "../client/src/state/store.ts";
import { finiteAmount, recordedMessage } from "../client/src/features/inspector/model.ts";
import { closePreviewTab, openTurnChanges, setChangedFilesExpanded, showPreviewFiles, toggleChangedFile } from "../client/src/features/files/actions.ts";
import { openSubagentTask } from "../client/src/features/conversation/actions.ts";

afterEach(() => setState(createInitialState()));

test("rail panels and programmatic file/changes opens remain mutually exclusive", () => {
	setState(createInitialState());
	openTurnChanges("u1", "src/a.ts");
	assert.equal(activeRightPanel(getState()), "changes");
	assert.equal(getState().preview.open, true);
	openRightPanel("summary");
	assert.equal(getState().preview.open, false);
	assert.equal(activeRightPanel(getState()), "summary");
	showPreviewFiles();
	assert.equal(activeRightPanel(getState()), "files");
	toggleRightPanel("files");
	assert.equal(activeRightPanel(getState()), null);
	assert.equal(getState().preview.changes?.turnId, "u1");
});

test("subagent entry points open the rail and preserve their parent selection", () => {
	setState({ ...createInitialState(), current: { id: "parent", cwd: "/w", status: "running" } });
	openSubagentTask("tool-1", 2);
	assert.equal(activeRightPanel(getState()), "subagent");
	assert.equal(getState().ui.childView?.parentId, "parent");
	openRightPanel("context");
	assert.equal(getState().ui.childView?.taskIndex, 2);
	setUi({ rightPanelExpanded: true });
	closeRightPanel();
	assert.equal(getState().ui.rightPanelExpanded, false);
	assert.equal(activeRightPanel(getState()), null);
});

test("unknown usage remains unknown and recorded JSON excludes opaque provider fields", () => {
	for (const value of [undefined, null, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(finiteAmount(value), undefined);
	assert.equal(finiteAmount(0), 0);
	assert.deepEqual(recordedMessage({ id: "a", type: "message", message: { role: "assistant", content: [
		{ type: "thinking", thinking: "Readable", signature: "opaque" },
		{ type: "thinking", thinking: "Secret", redacted: true },
		{ type: "image", data: "base64" },
	], transport: "hidden" } }), { role: "assistant", content: [
		{ type: "thinking", thinking: "Readable" },
		{ type: "thinking", thinking: undefined },
		{ type: "image" },
	] });
});

test("closing a retained file tab does not dismiss the summary or changes panel", () => {
	for (const panel of ["summary", "changes"] as const) {
		setState(createInitialState());
		setState((state) => ({
			preview: { ...state.preview, active: 0, tabs: [
				{ cwd: "/w", path: "a.ts", file: null, error: "", loading: false, rendered: false },
			] },
		}));
		openRightPanel(panel);
		closePreviewTab(0);
		assert.equal(activeRightPanel(getState()), panel);
		assert.equal(getState().preview.active, -1);
	}
});

test("a direct rail open selects the displayed latest turn on first diff expansion", () => {
	setState({
		...createInitialState(),
		current: { id: "parent", cwd: "/w", status: "idle" },
		timelineItems: [
			{ itemId: "u1", kind: "message", role: "user", entryId: "u1", content: "Edit" },
			{ itemId: "t1", kind: "tool", state: "completed", toolName: "edit", inputSummary: "", outputSummary: "",
				change: { path: "a.ts", patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new" } },
		],
	});
	openRightPanel("changes");
	setUi({ rightPanelExpanded: true });
	toggleChangedFile("a.ts");
	assert.equal(getState().preview.changes?.turnId, "u1");
	assert.equal(getState().preview.changes?.expanded.has("a.ts"), true);
	assert.equal(getState().ui.rightPanelExpanded, true);
	setChangedFilesExpanded([]);
	assert.equal(getState().preview.changes?.expanded.size, 0);
});
