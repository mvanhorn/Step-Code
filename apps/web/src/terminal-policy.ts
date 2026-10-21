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
		// Lets git and ssh in the terminal use the user's SSH agent, as in a desktop terminal.
		"SSH_AUTH_SOCK",
		"SSH_AGENT_PID",
	]);
	return {
		...Object.fromEntries(
			Object.entries(source).filter(([key, value]) => value !== undefined && names.has(key.toUpperCase())),
		),
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
	};
}

export function terminalShell(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[]; title: string } {
	if (platform === "win32") {
		const pwsh = join(env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
		const file = existsSync(pwsh)
			? pwsh
			: join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		// Like a desktop terminal, PowerShell loads the user's $PROFILE (so posh-git, oh-my-posh or
		// starship can show the Git branch) and keeps PSReadLine history. Only the console encoding
		// is set, after the profile, so non-ASCII output is not garbled.
		return {
			file,
			title: "PowerShell",
			args: [
				"-NoLogo",
				"-NoExit",
				"-Command",
				"[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
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
	// A login, interactive shell like iTerm2 or Terminal.app opens: the user's own startup files
	// (~/.zprofile and ~/.zshrc, ~/.bash_profile, ~/.profile) set PATH, aliases and the prompt,
	// including its Git branch.
	return { file, title: name, args: ["-l", "-i"] };
}
