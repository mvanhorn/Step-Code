import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface PosixProcess {
	pid: number;
	parent: number;
	group: number;
	/** Linux session id; macOS `ps` cannot report it. */
	session?: number;
	/** Controlling terminal name without `/dev/`, e.g. `pts/3` or `ttys012`. */
	tty?: string;
}

/**
 * Selects processes owned by one terminal shell. node-pty makes the shell a session leader with the
 * pty as its controlling terminal, so session or terminal membership also finds jobs that left the
 * shell's process tree (for example `sleep 1000 & exit`) or run in their own job-control groups.
 * `tty` must only be supplied while the pty is still open, otherwise a reused name could match a
 * stranger's terminal. After the shell exits its PID may be reused, so only session membership (Linux
 * never reuses a PID still naming a session) and the open terminal identify its leftovers.
 */
export function posixTerminalProcesses(
	processes: readonly PosixProcess[],
	shell: { pid: number; running: boolean; tty?: string },
	exclude: ReadonlySet<number>,
): number[] {
	const { tty } = shell;
	const owned = new Set<number>();
	const eligible = (pid: number) => Number.isSafeInteger(pid) && pid > 1 && !exclude.has(pid);
	for (const entry of processes) {
		if (!eligible(entry.pid)) continue;
		if (
			(shell.running && entry.pid === shell.pid) ||
			entry.session === shell.pid ||
			(tty !== undefined && entry.tty === tty)
		)
			owned.add(entry.pid);
	}
	let grown = true;
	while (grown) {
		grown = false;
		for (const entry of processes) {
			if (owned.has(entry.pid) || !eligible(entry.pid)) continue;
			if (owned.has(entry.parent) || owned.has(entry.group)) {
				owned.add(entry.pid);
				grown = true;
			}
		}
	}
	owned.delete(shell.pid);
	return [...owned];
}

async function linuxProcesses(): Promise<PosixProcess[]> {
	const processes: PosixProcess[] = [];
	for (const name of await readdir("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		let stat: string;
		try {
			stat = await readFile(`/proc/${name}/stat`, "utf8");
		} catch {
			continue; // The process exited while the table was read.
		}
		// The command name may contain spaces or parentheses; fields resume after the last ')'.
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const [parent, group, session] = [fields[1], fields[2], fields[3]].map(Number);
		processes.push({ pid: Number(name), parent, group, session });
	}
	return processes;
}

function psProcesses(): Promise<PosixProcess[]> {
	return new Promise((resolve, reject) => {
		execFile(
			"/bin/ps",
			["-A", "-o", "pid=,ppid=,pgid=,tty="],
			{ timeout: 3000, maxBuffer: 4_194_304 },
			(error, stdout) => {
				if (error) {
					reject(error);
					return;
				}
				const processes: PosixProcess[] = [];
				for (const line of stdout.split("\n")) {
					const [pid, parent, group, tty] = line.trim().split(/\s+/);
					if (!pid) continue;
					processes.push({
						pid: Number(pid),
						parent: Number(parent),
						group: Number(group),
						tty: tty && tty !== "??" && tty !== "?" ? tty : undefined,
					});
				}
				resolve(processes);
			},
		);
	});
}

/** Linux reads `/proc` so minimal images without procps still clean up; other POSIX hosts use `ps`. */
export function posixProcessTable(): Promise<PosixProcess[]> {
	return process.platform === "linux" ? linuxProcesses() : psProcesses();
}

interface WindowsProcess {
	pid: number;
	parent: number;
	startedAt: number;
}

/** Windows preserves the creating PID after its process exits; creation times
 * exclude older PID generations and are checked again against an open handle. */
export function terminalDescendants(
	processes: readonly WindowsProcess[],
	root: number,
	startedAt: number,
	exitedAt: number,
): WindowsProcess[] {
	const owned: WindowsProcess[] = [];
	const queue = [{ pid: root, startedAt, exitedAt }];
	const visited = new Set([root]);
	for (const parent of queue) {
		for (const child of processes) {
			if (
				child.parent !== parent.pid ||
				visited.has(child.pid) ||
				child.startedAt < parent.startedAt ||
				child.startedAt > parent.exitedAt
			)
				continue;
			visited.add(child.pid);
			owned.push(child);
			queue.push({ ...child, exitedAt: Infinity });
		}
	}
	return owned.reverse();
}

function powershell(script: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-EncodedCommand",
				Buffer.from(script, "utf16le").toString("base64"),
			],
			{ windowsHide: true, timeout: 10_000, maxBuffer: 1_048_576 },
			(error, stdout) => {
				if (error) reject(new Error("Terminal descendant cleanup failed", { cause: error }));
				else resolve(stdout);
			},
		);
	});
}

export async function cleanExitedWindowsShell(root: number, startedAt: number, exitedAt: number): Promise<void> {
	const raw: unknown = JSON.parse(
		await powershell(`
$ErrorActionPreference = 'Stop'
ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | ForEach-Object {
	[pscustomobject]@{
		pid = [int]$_.ProcessId
		parent = [int]$_.ParentProcessId
		startedAt = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()
	}
})`),
	);
	if (!Array.isArray(raw)) throw new Error("Invalid terminal process listing");
	const processes: WindowsProcess[] = [];
	for (const candidate of raw as unknown[]) {
		if (!candidate || typeof candidate !== "object") throw new Error("Invalid terminal process identity");
		const value = candidate as Record<string, unknown>;
		if (
			typeof value.pid !== "number" ||
			typeof value.parent !== "number" ||
			typeof value.startedAt !== "number" ||
			!Number.isSafeInteger(value.pid) ||
			value.pid < 0 ||
			!Number.isSafeInteger(value.parent) ||
			value.parent < 0 ||
			!Number.isSafeInteger(value.startedAt)
		)
			throw new Error("Invalid terminal process identity");
		processes.push({ pid: value.pid, parent: value.parent, startedAt: value.startedAt });
	}
	const owned = terminalDescendants(processes, root, startedAt, exitedAt);
	if (!owned.length) return;
	const identities = owned.map((child) => `@{ Id = ${child.pid}; StartedAt = ${child.startedAt} }`).join(",");
	await powershell(`
$ErrorActionPreference = 'Stop'
foreach ($identity in @(${identities})) {
	$process = $null
	try {
		try { $process = [Diagnostics.Process]::GetProcessById($identity.Id) }
		catch [ArgumentException] { continue }
		$null = $process.Handle
		if ($process.HasExited) { continue }
		if (([DateTimeOffset]$process.StartTime).ToUnixTimeMilliseconds() -ne $identity.StartedAt) { continue }
		$process.Kill()
		if (-not $process.WaitForExit(3000)) { throw 'Terminal descendant did not exit' }
	} finally {
		if ($null -ne $process) { $process.Dispose() }
	}
}`);
}
