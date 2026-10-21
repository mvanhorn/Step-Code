import assert from "node:assert/strict";
import test from "node:test";
import { formatStartupBanner, resolveLaunchPort } from "../src/banner.ts";

const banner = formatStartupBanner({ port: 3077, token: "abc-123_XYZ", version: "1.2.3" });

test("the launch URL is present and carries the token", () => {
	assert.match(banner, /http:\/\/127\.0\.0\.1:3077\/#token=abc-123_XYZ/u);
});

test("the token is also on its own line for easy copying", () => {
	assert.match(banner, /\n {2}Token: {4}abc-123_XYZ\n/u);
});

test("every label/value row starts its value at the same column", () => {
	const rows = banner.split("\n").filter((line) => /^ {2}(Local|Network|Token|Stop):/u.test(line));
	assert.equal(rows.length, 4);
	// Capture the label plus its padding; that field must be one fixed width.
	const starts = rows.map((row) => row.match(/^ {2}(\S+:\s*)/u)?.[1].length ?? -1);
	assert.deepEqual(starts, [10, 10, 10, 10]);
});

test("the headline leads the block and the subtitle follows it", () => {
	const lines = banner.split("\n");
	assert.equal(lines[0], "  StepCode Web ready  1.2.3");
	assert.equal(lines[1], "  Local web UI is available from this machine.");
});

test("the banner is text only, with no block-art mark", () => {
	assert.doesNotMatch(banner, /[▐▌█▀▄▖▗▘▝▙▛▜▟▞▚]/u);
});

test("the port and version are interpolated, not hardcoded", () => {
	const other = formatStartupBanner({ port: 58627, token: "t", version: "9.9.9" });
	assert.match(other, /http:\/\/127\.0\.0\.1:58627\/#token=t/u);
	assert.ok(other.split("\n").includes("  StepCode Web ready  9.9.9"));
});

test("the launch port is the host port unless a client dev server port is set", () => {
	assert.equal(resolveLaunchPort({}, 3077), 3077);
	assert.equal(resolveLaunchPort({ STEPCODE_WEB_CLIENT_PORT: " " }, 3077), 3077);
	assert.equal(resolveLaunchPort({ STEPCODE_WEB_CLIENT_PORT: "5173" }, 3077), 5173);
});

test("an invalid client dev server port fails instead of falling back", () => {
	for (const value of ["abc", "0", "65536", "51.5"]) {
		assert.throws(() => resolveLaunchPort({ STEPCODE_WEB_CLIENT_PORT: value }, 3077), /STEPCODE_WEB_CLIENT_PORT/u);
	}
});

test("the network row states the real binding instead of an unimplemented flag", () => {
	assert.match(banner, /Network: {2}off {2}bound to 127\.0\.0\.1/u);
	assert.doesNotMatch(banner, /--host/u);
});
