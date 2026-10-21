import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { browserKeyRoute } from "../client/src/features/browser/actions.ts";
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

test("browser keys: AltGr and macOS Option characters are typed text, Ctrl/Cmd chords stay keys", () => {
	const plain = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, altGraph: false };
	// Plain characters and paste go through the native input; copy reads the page selection.
	assert.deepEqual(browserKeyRoute({ ...plain, key: "a" }, false), { kind: "native" });
	assert.deepEqual(browserKeyRoute({ ...plain, key: "v", ctrlKey: true }, false), { kind: "native" });
	assert.deepEqual(browserKeyRoute({ ...plain, key: "c", metaKey: true }, true), { kind: "copy" });
	// AltGr: reported as AltGraph, or as Ctrl+Alt on Windows. Neither is a Ctrl shortcut.
	assert.deepEqual(browserKeyRoute({ ...plain, key: "@", altGraph: true, ctrlKey: true, altKey: true }, false), { kind: "native" });
	assert.deepEqual(browserKeyRoute({ ...plain, key: "€", ctrlKey: true, altKey: true }, false), { kind: "native" });
	assert.deepEqual(browserKeyRoute({ ...plain, key: "c", ctrlKey: true, altKey: true }, false), { kind: "native" });
	// macOS Option prints characters; Option with a non-character key is still a key.
	assert.deepEqual(browserKeyRoute({ ...plain, key: "π", altKey: true }, true), { kind: "native" });
	assert.deepEqual(browserKeyRoute({ ...plain, key: "ArrowLeft", altKey: true }, true), { kind: "key", key: "ArrowLeft", modifiers: 1 });
	// Elsewhere Alt+letter types nothing in a textarea, so it reaches the page as a chord.
	assert.deepEqual(browserKeyRoute({ ...plain, key: "f", altKey: true }, false), { kind: "key", key: "f", modifiers: 1 });
	assert.deepEqual(browserKeyRoute({ ...plain, key: "a", metaKey: true }, true), { kind: "key", key: "a", modifiers: 4 });
	assert.deepEqual(browserKeyRoute({ ...plain, key: "AltGraph", altGraph: true }, false), { kind: "ignore" });
});
