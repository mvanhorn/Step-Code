import { execFile } from "node:child_process";
import { join } from "node:path";

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
