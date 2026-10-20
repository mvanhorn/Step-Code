import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { terminalEnvironment, terminalInput, terminalShell, terminalSize } from "../src/terminal-policy.ts";
import { terminalRoute } from "../src/terminal-routes.ts";
import { WebTerminals } from "../src/terminal.ts";

async function waitFor(check: () => boolean, message: string): Promise<void> {
	for (let n = 0; n < 150; n++) {
		if (check()) return;
		await delay(100);
	}
	assert.fail(message);
}
function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch { return false; }
}

test("terminal policy bounds input and dimensions, excludes Host credentials and loader injection", () => {
	assert.deepEqual(terminalSize(80, 24), { cols: 80, rows: 24 });
	for (const [cols, rows] of [[1, 24], [501, 24], [80, 0], [80, 301], [1.5, 24], [NaN, 24]])
		assert.throws(() => terminalSize(cols, rows));
	assert.equal(terminalInput("\x03中文\r"), "\x03中文\r");
	for (const value of [null, "", "中".repeat(22000)]) assert.throws(() => terminalInput(value));
	const env = terminalEnvironment({ PATH: "safe", STEP_API_KEY: "secret", NODE_OPTIONS: "--require injected", BASH_ENV: "injected", ENV: "injected", TSX_TSCONFIG_PATH: "injected", HOME: "/home" });
	assert.equal(env.PATH, "safe");
	assert.equal(env.HOME, "/home");
	assert.equal(env.STEP_API_KEY, undefined);
	assert.equal(env.NODE_OPTIONS, undefined);
	assert.equal(env.BASH_ENV, undefined);
	assert.equal(env.ENV, undefined);
	assert.equal(env.TERM, "xterm-256color");
	assert.ok(terminalShell("win32").args.includes("-NoProfile"));
	assert.ok(["bash", "sh"].includes(terminalShell("linux", { SHELL: "/definitely-missing/bash" }).title));
});

test("terminal HTTP adapter rejects unknown workspaces, malformed JSON and unknown routes", async () => {
	const terminals = new WebTerminals();
	const server = createServer((request, response) => {
		const url = new URL(request.url || "/", "http://localhost");
		void terminalRoute(terminals, url.pathname.split("/").filter(Boolean), url, request, response, async () => undefined);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const root = `http://127.0.0.1:${address.port}`;
	try {
		assert.equal((await fetch(`${root}/?cwd=unregistered`)).status, 403);
		assert.equal((await fetch(root, { method: "POST", body: "{" })).status, 400);
		assert.equal((await fetch(`${root}/bad/input`, { method: "POST", body: '{"data":""}' })).status, 404);
		assert.equal((await fetch(`${root}/bad/events?after=0`)).status, 404);
		assert.equal((await fetch(`${root}/bad`, { method: "DELETE" })).status, 404);
		assert.equal((await fetch(root, { method: "POST", body: JSON.stringify({ cwd: "x", data: "a".repeat(524289) }) })).status, 413);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await terminals.stopAll();
	}
});

test("native terminal: Unicode output, resize, interrupt, bounded replay, reconnect, close and shutdown cleanup", { skip: process.env.STEPCODE_WEB_TERMINAL_TEST !== "1", timeout: 60000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "stepcode-terminal-"));
	const terminals = new WebTerminals();
	const external = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
	try {
		const created = await terminals.create(cwd);
		const id = created.info.id;
		const pid = created.info.pid;
		assert.ok(pid && alive(pid));
		assert.equal(created.info.status, "running");
		let callbacks = 0;
		const detach = terminals.subscribe(id, () => callbacks++);
		const windows = process.platform === "win32";
		const output = () => terminals.snapshot(id).chunks.map((chunk) => chunk.data).join("");
		await terminals.write(id, windows ? "[Console]::WriteLine('中文验收' + (17*19))\r" : "printf '中文验收%s\\n' \"$((17*19))\"\r");
		await waitFor(() => output().includes("中文验收323"), "Unicode output did not arrive");
		assert.ok(callbacks > 0);
		await terminals.resize(id, 100, 32);
		assert.equal(terminals.snapshot(id).info.cols, 100);
		assert.equal(terminals.snapshot(id).info.rows, 32);
		detach();
		const cursor = terminals.snapshot(id).seq;
		const before = callbacks;
		await terminals.write(id, windows ? "[Console]::WriteLine('RE' + 'ATTACHED')\r" : "printf 'RE%s\\n' ATTACHED\r");
		await waitFor(() => output().includes("REATTACHED"), "Hidden terminal stopped reading");
		assert.equal(callbacks, before);
		const replay = terminals.snapshot(id, cursor);
		assert.match(replay.chunks.map((chunk) => chunk.data).join(""), /REATTACHED/);
		assert.equal(replay.info.pid, pid);
		assert.throws(() => terminals.snapshot(id, replay.seq + 1));
		await terminals.write(id, windows ? "Start-Sleep -Seconds 30\r" : "sleep 30\r");
		await delay(300);
		await terminals.write(id, "\x03");
		await delay(700);
		await terminals.write(id, windows ? "\r[Console]::WriteLine('INTERRUPT' + 'ED')\r" : "\rprintf 'INTERRUPT%s\\n' ED\r");
		await waitFor(() => output().includes("INTERRUPTED"), "Interrupt did not return to the shell");
		await terminals.write(id, windows ? "[Console]::Write(('Q' * 600000)); [Console]::WriteLine('OUTPUT' + 'END')\r" : "printf '%600000s' ' '; printf 'OUTPUT%s\\n' END\r");
		await waitFor(() => output().includes("OUTPUTEND"), "High-output terminal did not finish");
		const bounded = terminals.snapshot(id);
		assert.ok(bounded.truncated);
		assert.ok(bounded.chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.data), 0) <= 524288);
		const fixture = join(cwd, "child.cjs");
		await writeFile(fixture, "setInterval(() => {}, 1000);");
		const childCommand = windows
			? `$p = Start-Process -FilePath '${process.execPath.replaceAll("'", "''")}' -ArgumentList '"${fixture.replaceAll("'", "''")}"' -NoNewWindow -PassThru; [Console]::WriteLine('CHILD' + 'PID:' + $p.Id)\r`
			: `'${process.execPath.replaceAll("'", "'\\''")}' '${fixture.replaceAll("'", "'\\''")}' & printf 'CHILDPID:%s\\n' $!\r`;
		await terminals.write(id, childCommand);
		await waitFor(() => /CHILDPID:\d+/.test(output()), "Owned descendant did not start");
		const childPid = Number(output().match(/CHILDPID:(\d+)/)?.[1]);
		assert.ok(childPid > 0 && alive(childPid));
		// A job that left the shell's process tree is still owned through its session or terminal.
		let orphanPid = 0;
		if (!windows) {
			await terminals.write(id, `sh -c '"${process.execPath.replaceAll("'", "'\\''")}" "${fixture.replaceAll("'", "'\\''")}" & echo ORPHAN:$!'\r`);
			await waitFor(() => /ORPHAN:\d+/.test(output()), "Orphaned job did not start");
			orphanPid = Number(output().match(/ORPHAN:(\d+)/)?.[1]);
			assert.ok(orphanPid > 0 && alive(orphanPid));
		}
		await terminals.close(id);
		assert.equal(alive(pid), false);
		assert.equal(alive(childPid), false, "Owned descendant survived terminal close");
		if (orphanPid) assert.equal(alive(orphanPid), false, "Orphaned job survived terminal close");
		assert.equal(terminals.list(cwd).length, 0);
		assert.throws(() => terminals.snapshot(id));
		const natural = await terminals.create(cwd);
		assert.equal(natural.info.title, `${basename(cwd)}`, "Tabs are named after the workspace folder");
		const numbered = await terminals.create(cwd);
		assert.equal(numbered.info.title, `${basename(cwd)} 2`);
		await terminals.close(numbered.info.id);
		await terminals.write(natural.info.id, "exit 7\r");
		await waitFor(() => terminals.snapshot(natural.info.id).info.status === "exited", "Natural shell exit was not reported");
		assert.equal(terminals.snapshot(natural.info.id).info.exitCode, 7);
		await assert.rejects(terminals.write(natural.info.id, "echo late\r"), /not running/);
		await terminals.close(natural.info.id);
		const second = await terminals.create(cwd);
		assert.ok(second.info.pid);
		await terminals.stopAll();
		assert.equal(alive(second.info.pid), false);
		assert.ok(external.pid && alive(external.pid), "Unrelated process was terminated");
		await assert.rejects(terminals.create(cwd), /shutting down/);
	} finally {
		await terminals.stopAll();
		external.kill();
		await rm(cwd, { recursive: true, force: true });
	}
});

test("closing during terminal startup settles the pending creation", { skip: process.env.STEPCODE_WEB_TERMINAL_TEST !== "1", timeout: 20000 }, async () => {
	const terminals = new WebTerminals();
	const cwd = await mkdtemp(join(tmpdir(), "stepcode-terminal-cancel-"));
	try {
		const creating = terminals.create(cwd).then(() => "ready", () => "closed");
		// Registration follows an asynchronous native-support check; close before the helper is ready.
		for (let n = 0; n < 2000 && terminals.list(cwd).length === 0; n++) await delay(1);
		const id = terminals.list(cwd)[0].id;
		await terminals.close(id);
		assert.equal(await creating, "closed");
		assert.equal(terminals.list(cwd).length, 0);
	} finally {
		await terminals.stopAll();
		await rm(cwd, { recursive: true, force: true });
	}
});
