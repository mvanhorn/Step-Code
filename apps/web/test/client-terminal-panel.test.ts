import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { activeRightPanel, closeRightPanel, openRightPanel } from "../client/src/state/right-panel.ts";
import { appStore, createInitialState } from "../client/src/state/store.ts";
import { MESSAGES } from "../client/src/i18n/messages.ts";
import { terminalWorkspaceKey } from "../client/src/features/terminal/actions.ts";

test("terminal workspace keys normalize Windows spelling without folding POSIX case", () => {
	assert.equal(terminalWorkspaceKey("D:\\Project\\"), terminalWorkspaceKey("d:/project"));
	assert.notEqual(terminalWorkspaceKey("/home/Project"), terminalWorkspaceKey("/home/project"));
	assert.equal(terminalWorkspaceKey("/"), "/");
});

test("terminal is directly below Context and shares the exclusive inspector", () => {
	const source = readFileSync(new URL("../client/src/features/inspector/RightPanel.tsx", import.meta.url), "utf8");
	assert.match(source, /id: "context"[^}]*},\s*{ id: "terminal"/);
	appStore.setState(createInitialState());
	openRightPanel("terminal");
	assert.equal(activeRightPanel(appStore.getState()), "terminal");
	openRightPanel("browser");
	assert.equal(activeRightPanel(appStore.getState()), "browser");
	closeRightPanel();
	assert.equal(activeRightPanel(appStore.getState()), null);
});
test("all terminal messages are present in both locales", () => {
	const zh = MESSAGES["zh-CN"];
	const en = MESSAGES["en-US"];
	for (const key of Object.keys(zh).filter((key) => key.startsWith("terminal"))) {
		assert.ok(en[key], key);
		assert.deepEqual([...zh[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]), [...en[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]));
	}
});
