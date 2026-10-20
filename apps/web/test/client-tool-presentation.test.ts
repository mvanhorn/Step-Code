import assert from "node:assert/strict";
import test from "node:test";
import { toolKind, toolLabel } from "../client/src/features/conversation/tool-presentation.ts";
import { translate, type TranslateFn } from "../client/src/i18n/index.ts";
import { LOCALES, MESSAGES } from "../client/src/i18n/messages.ts";
import type { ToolState } from "../client/src/state/types.ts";

const zh: TranslateFn = (key, values) => translate("zh-CN", key, values);
const en: TranslateFn = (key, values) => translate("en-US", key, values);

test("tool actions follow each call's authoritative state in both languages", () => {
	for (const toolName of ["bash", "powershell"]) {
		assert.equal(toolLabel({ toolName, state: "pending" }, zh), "正在运行命令");
		assert.equal(toolLabel({ toolName, state: "completed" }, zh), "运行了命令");
		assert.equal(toolLabel({ toolName, state: "failed" }, en), "Command failed");
	}
	assert.equal(toolLabel({ toolName: "read", state: "completed" }, en), "Read file");
	assert.equal(toolLabel({ toolName: "read", state: "failed" }, zh), "读取文件失败");
	assert.equal(toolLabel({ toolName: "find", state: "completed" }, en), "Found files");
	assert.equal(toolKind({ toolName: "find" }), "search");
});

test("all supported actions have explicit translations for every host state", () => {
	const states: ToolState[] = ["pending", "completed", "failed"];
	for (const locale of LOCALES) {
		for (const action of ["read", "write", "edit", "bash", "search", "find", "list", "other"]) {
			for (const state of states) {
				assert.ok(Object.hasOwn(MESSAGES[locale], `toolAction.${action}.${state}`));
				assert.ok(Object.hasOwn(MESSAGES[locale], `toolStatus.${state}`));
			}
		}
	}
});

test("unknown tools keep their names without inheriting object prototype properties", () => {
	for (const toolName of ["mcp.custom", "constructor", "toString", "__proto__"]) {
		assert.equal(toolKind({ toolName }), "other");
		assert.equal(toolLabel({ toolName, state: "pending" }, en), `Calling ${toolName}`);
		assert.equal(toolLabel({ toolName, state: "failed" }, zh), `调用 ${toolName} 失败`);
	}
	assert.equal(toolLabel({ toolName: "", state: "completed" }, en), "Called Tool");
});

test("one completed call does not settle another pending call", () => {
	const first = { toolName: "write", state: "completed" as const };
	const second = { toolName: "read", state: "pending" as const };
	assert.equal(toolLabel(first, zh), "写入了文件");
	assert.equal(toolLabel(second, zh), "正在读取文件");
	assert.equal(second.state, "pending");
});
