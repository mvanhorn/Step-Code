import { existsSync } from "node:fs";
import { basename, join } from "node:path";

export class TerminalError extends Error {
	readonly status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

export function terminalSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
	if (
		typeof cols !== "number" ||
		!Number.isInteger(cols) ||
		cols < 2 ||
		cols > 500 ||
		typeof rows !== "number" ||
		!Number.isInteger(rows) ||
		rows < 1 ||
		rows > 300
	)
		throw new TerminalError("Invalid terminal dimensions");
	return { cols, rows };
}

export function terminalInput(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 65536)
		throw new TerminalError("Terminal input must contain 1 to 65536 bytes");
	return value;
}

/** Do not forward the Host's API keys, Node loaders or injected startup commands. */
export function terminalEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const names = new Set([
		"PATH",
		"PATHEXT",
		"SYSTEMROOT",
		"WINDIR",
		"COMSPEC",
		"OS",
		"PROGRAMFILES",
		"PROGRAMFILES(X86)",
		"PROGRAMW6432",
		"PROGRAMDATA",
		"COMMONPROGRAMFILES",
		"COMMONPROGRAMFILES(X86)",
		"COMMONPROGRAMW6432",
		"USERPROFILE",
		"HOMEDRIVE",
		"HOMEPATH",
		"HOME",
		"APPDATA",
		"LOCALAPPDATA",
		"TEMP",
		"TMP",
		"TMPDIR",
		"USERNAME",
		"USER",
		"LOGNAME",
		"USERDOMAIN",
		"COMPUTERNAME",
		"PSMODULEPATH",
		"NUMBER_OF_PROCESSORS",
		"PROCESSOR_ARCHITECTURE",
		"PROCESSOR_ARCHITEW6432",
		"LANG",
		"LC_ALL",
		"LC_CTYPE",
		"TZ",
		"SHELL",
	]);
	return {
		...Object.fromEntries(
			Object.entries(source).filter(([key, value]) => value !== undefined && names.has(key.toUpperCase())),
		),
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
		HISTFILE: process.platform === "win32" ? "NUL" : "/dev/null",
		LESSHISTFILE: "-",
	};
}

// The current branch, or the short commit of a detached HEAD; empty outside a repository or without git.
const GIT_HEAD = "git symbolic-ref --short -q HEAD 2>/dev/null || git rev-parse --short -q HEAD 2>/dev/null";

/**
 * Startup scripts are skipped (see below), so the shell would otherwise show only the host name.
 * This prompt shows the directory name and, inside a Git repository, its branch:
 * `➜ Step-Code git:(main)`, or `➜ Downloads` elsewhere. It is re-evaluated at every prompt, so a
 * `cd` or `git switch` shows up immediately.
 */
const SHELL_PROMPTS: Readonly<Record<string, string>> = {
	zsh: `%F{green}➜%f %F{cyan}%1~%f$(b=$(${GIT_HEAD}); [ -n "$b" ] && printf ' %%F{blue}git:(%%F{red}%s%%F{blue})%%f' "$b") `,
	bash: String.raw`\[\e[32m\]➜\[\e[0m\] \[\e[36m\]\W\[\e[0m\]$(b=$(${GIT_HEAD}); [ -n "$b" ] && printf ' \[\e[34m\]git:(\[\e[31m\]%s\[\e[34m\])\[\e[0m\]' "$b") `,
};

export function terminalShell(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[]; title: string; env?: Record<string, string> } {
	if (platform === "win32") {
		const pwsh = join(env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
		const file = existsSync(pwsh)
			? pwsh
			: join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		return {
			file,
			title: "PowerShell",
			args: [
				"-NoLogo",
				"-NoProfile",
				"-NoExit",
				"-Command",
				"[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); if (Get-Module -ListAvailable PSReadLine) { Import-Module PSReadLine; Set-PSReadLineOption -HistorySaveStyle SaveNothing; if ((Get-Command Set-PSReadLineOption).Parameters.ContainsKey('PredictionSource')) { Set-PSReadLineOption -PredictionSource None } }",
			],
		};
	}
	const supported = new Set(["bash", "zsh", "sh"]);
	const preferred = env.SHELL;
	const file =
		preferred?.startsWith("/") && supported.has(basename(preferred)) && existsSync(preferred)
			? preferred
			: platform === "darwin" && existsSync("/bin/zsh")
				? "/bin/zsh"
				: existsSync("/bin/bash")
					? "/bin/bash"
					: "/bin/sh";
	const name = basename(file);
	// Suppress user startup scripts: opening a terminal must not run an unknown profile.
	const prompt = SHELL_PROMPTS[name];
	return {
		file,
		title: name,
		args:
			name === "bash"
				? ["--noprofile", "--norc", "-i"]
				: name === "zsh"
					? ["-f", "-o", "PROMPT_SUBST", "-i"]
					: ["-i"],
		...(prompt ? { env: { PS1: prompt } } : {}),
	};
}
