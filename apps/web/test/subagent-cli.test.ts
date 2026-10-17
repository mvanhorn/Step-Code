import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveSubagentCliPath } from "../src/subagent-cli.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

// Regression: subagents launched from the Web host re-ran server.ts with
// `--mode rpc` and exited with code 1. The entry must be the Step CLI.
test("a source host points children at the CLI source in the same checkout", () => {
	const hostUrl = pathToFileURL(join(repoRoot, "apps/web/src/runtime.ts")).href;
	const entry = resolveSubagentCliPath(hostUrl, "/unused");
	assert.equal(entry, join(repoRoot, "apps/cli/src/main.ts"));
	assert.ok(existsSync(entry));
});

test("a compiled host points children at the coding-agent bundle", () => {
	const hostUrl = pathToFileURL(join(repoRoot, "apps/web/dist/runtime.js")).href;
	assert.equal(resolveSubagentCliPath(hostUrl, "/pkg/coding-agent"), "/pkg/coding-agent/dist/bundle/step.js");
});

test("a source host outside a checkout falls back to the bundle", () => {
	assert.equal(
		resolveSubagentCliPath("file:///elsewhere/web/src/runtime.ts", "/pkg/coding-agent"),
		"/pkg/coding-agent/dist/bundle/step.js",
	);
});
