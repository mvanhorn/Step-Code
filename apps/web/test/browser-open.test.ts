import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recordBrowserOpened, shouldOpenBrowser } from "../src/browser-open.ts";

const never = () => false;
const always = () => true;

test("stays closed when the variable is absent", () => {
	assert.equal(shouldOpenBrowser({}, never), false);
});

test("accepts the documented truthy spellings", () => {
	for (const value of ["1", "true", "TRUE", "on", " 1 "])
		assert.equal(shouldOpenBrowser({ STEPCODE_WEB_OPEN: value }, never), true, value);
});

test("stays closed for anything else, including an explicit opt-out", () => {
	for (const value of ["0", "false", "off", "no", ""]) assert.equal(shouldOpenBrowser({ STEPCODE_WEB_OPEN: value }, never), false, value);
});

test("opens when no marker file is configured", () => {
	assert.equal(shouldOpenBrowser({ STEPCODE_WEB_OPEN: "1" }, always), true);
});

test("a restart with the marker already written does not open again", () => {
	const env = { STEPCODE_WEB_OPEN: "1", STEPCODE_WEB_OPEN_MARKER: "/tmp/run/opened" };
	assert.equal(shouldOpenBrowser(env, always), false);
	assert.equal(shouldOpenBrowser(env, never), true);
});

test("an empty marker path is treated as no marker", () => {
	assert.equal(shouldOpenBrowser({ STEPCODE_WEB_OPEN: "1", STEPCODE_WEB_OPEN_MARKER: "  " }, always), true);
});

test("recording is a no-op without a marker path", () => {
	assert.doesNotThrow(() => recordBrowserOpened({ STEPCODE_WEB_OPEN: "1" }));
});

test("recording a marker makes the next start stay closed", () => {
	const directory = mkdtempSync(join(tmpdir(), "stepcode-web-open-test-"));
	try {
		const env = { STEPCODE_WEB_OPEN: "1", STEPCODE_WEB_OPEN_MARKER: join(directory, "nested", "opened") };
		assert.equal(shouldOpenBrowser(env, existsSync), true);
		recordBrowserOpened(env);
		assert.equal(existsSync(env.STEPCODE_WEB_OPEN_MARKER), true);
		assert.equal(shouldOpenBrowser(env, existsSync), false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
