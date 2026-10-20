import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { terminalDescendants } from "../src/terminal-cleanup.ts";
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
