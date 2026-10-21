import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { posixTerminalProcesses, terminalDescendants } from "../src/terminal-cleanup.ts";
import { terminalSupport } from "../src/terminal-native.ts";
import { WebTerminals } from "../src/terminal.ts";

test("terminal descendant discovery excludes older and reused root PID generations", () => {
	const processes = [
		{ pid: 2, parent: 1, startedAt: 200 },
		{ pid: 3, parent: 2, startedAt: 400 },
		{ pid: 4, parent: 1, startedAt: 50 },
		{ pid: 5, parent: 1, startedAt: 500 },
		{ pid: 6, parent: 99, startedAt: 200 },
		{ pid: 7, parent: 2, startedAt: 150 },
	];
	assert.deepEqual(terminalDescendants(processes, 1, 100, 300).map((child) => child.pid), [3, 2]);
});

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch { return false; }
}

test("Windows shell exit cleans hidden descendants before close or host shutdown, preserving external processes", {
	skip: process.platform !== "win32" || process.env.STEPCODE_WEB_TERMINAL_TEST !== "1",
	timeout: 60_000,
}, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "stepcode-terminal-exit-"));
	const fixture = join(cwd, "child.cjs");
	await writeFile(fixture, "setInterval(() => {}, 1000);");
	const external = spawn(process.execPath, [fixture], { windowsHide: true, stdio: "ignore" });
	const owned: number[] = [];
	const waitFor = async (predicate: () => boolean) => {
		for (let n = 0; n < 200; n++) {
			if (predicate()) return;
			await delay(50);
		}
		assert.fail("Terminal exit fixture timed out");
	};
	try {
		for (const action of ["close", "shutdown"]) {
			const terminals = new WebTerminals();
			try {
				const created = await terminals.create(cwd);
				const id = created.info.id;
				const output = () => terminals.snapshot(id).chunks.map((chunk) => chunk.data).join("");
				await terminals.write(id,
					`$p = Start-Process -FilePath '${process.execPath.replaceAll("'", "''")}' -ArgumentList '"${fixture.replaceAll("'", "''")}"' -WindowStyle Hidden -PassThru; [Console]::WriteLine('OWNED' + 'PID:' + $p.Id); exit 7\r`);
				await waitFor(() => /OWNEDPID:\d+/.test(output()));
				const childPid = Number(output().match(/OWNEDPID:(\d+)/)?.[1]);
				owned.push(childPid);
				await waitFor(() => terminals.snapshot(id).info.status === "exited");
				assert.equal(terminals.snapshot(id).info.exitCode, 7);
				if (action === "close") await terminals.close(id);
				else await terminals.stopAll();
				assert.equal(alive(childPid), false, `Owned child survived ${action} after shell exit`);
				assert.ok(external.pid && alive(external.pid));
				assert.equal(terminals.list(cwd).length, 0);
			} finally {
				await terminals.stopAll();
			}
		}
	} finally {
		for (const pid of owned) if (alive(pid)) process.kill(pid);
		external.kill();
		await rm(cwd, { recursive: true, force: true });
	}
});

test("POSIX ownership follows session, terminal, parent and group but never the Host or helper", () => {
	const table = [
		{ pid: 100, parent: 50, group: 100, session: 100, tty: "pts/3" }, // shell
		{ pid: 101, parent: 100, group: 101, session: 100, tty: "pts/3" }, // job in its own group
		{ pid: 102, parent: 1, group: 102, session: 100 }, // orphaned background job
		{ pid: 103, parent: 1, group: 103, tty: "ttys009" }, // macOS: only the terminal identifies it
		{ pid: 104, parent: 103, group: 103 }, // descendant without a terminal
		{ pid: 105, parent: 1, group: 105, session: 900, tty: "pts/4" }, // unrelated
		{ pid: 50, parent: 1, group: 50, session: 50 }, // helper
	];
	assert.deepEqual(
		posixTerminalProcesses(table, { pid: 100, running: true, tty: "ttys009" }, new Set([50])).sort(),
		[101, 102, 103, 104],
	);
	// After the shell exits its PID may be reused and its terminal name recycled: only the session counts.
	assert.deepEqual(posixTerminalProcesses(table, { pid: 100, running: false }, new Set([50])).sort(), [101, 102]);
	assert.deepEqual(posixTerminalProcesses(table, { pid: 999, running: true }, new Set()), []);
});

test("native terminal support reports missing builds and repairs a non-executable macOS spawn-helper", { skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "stepcode-node-pty-"));
	try {
		const missing = await terminalSupport("linux", "x64", () => root);
		assert.equal(missing.available, false);
		assert.match(missing.available ? "" : missing.reason, /no native build for linux-x64/);
		const prebuilds = join(root, "prebuilds", "darwin-arm64");
		await mkdir(prebuilds, { recursive: true });
		await writeFile(join(prebuilds, "pty.node"), "");
		await writeFile(join(prebuilds, "spawn-helper"), "");
		await chmod(join(prebuilds, "spawn-helper"), 0o644);
		assert.deepEqual(await terminalSupport("darwin", "arm64", () => root), { available: true });
		assert.equal((await stat(join(prebuilds, "spawn-helper"))).mode & 0o777, 0o755);
		assert.deepEqual(await terminalSupport("linux", "arm64", () => join(root, "missing")), {
			available: false,
			reason: "node-pty has no native build for linux-arm64. Run `pnpm rebuild node-pty` with a C++ build toolchain, then retry.",
		});
		const unresolved = await terminalSupport("darwin", "arm64", () => {
			throw new Error("not found");
		});
		assert.equal(unresolved.available, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
