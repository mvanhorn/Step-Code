import { existsSync } from "node:fs";
import { join } from "node:path";

export class BrowserRequestError extends Error {
	readonly status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

/** Block the host ports on every hostname, including DNS aliases/rebinding. */
export function browserUrl(raw: unknown, hostPorts: readonly number[], allowBlank = false): string {
	if (allowBlank && raw === "about:blank") return raw;
	if (typeof raw !== "string" || !raw.trim() || raw.length > 8192)
		throw new BrowserRequestError("Enter an HTTP or HTTPS address");
	let url: URL;
	try {
		url = new URL(raw.includes("://") ? raw.trim() : `https://${raw.trim()}`);
	} catch {
		throw new BrowserRequestError("Invalid browser address");
	}
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
		throw new BrowserRequestError("Only HTTP and HTTPS addresses without credentials are allowed");
	if (hostPorts.includes(Number(url.port || (url.protocol === "https:" ? 443 : 80))))
		throw new BrowserRequestError("The embedded browser cannot access StepCode host ports");
	return url.href;
}

export function browserExecutable(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
	const configured = env.STEPCODE_WEB_BROWSER_PATH?.trim();
	const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(
		(value): value is string => !!value,
	);
	const candidates = configured
		? [configured]
		: platform === "win32"
			? roots.flatMap((root) => [
					join(root, "Google/Chrome/Application/chrome.exe"),
					join(root, "Microsoft/Edge/Application/msedge.exe"),
				])
			: platform === "darwin"
				? [
						"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
						"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
						"/Applications/Chromium.app/Contents/MacOS/Chromium",
					]
				: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
	const executable = candidates.find(existsSync);
	if (!executable)
		throw new BrowserRequestError("Chrome/Edge not found. Set STEPCODE_WEB_BROWSER_PATH to its executable.", 503);
	return executable;
}

export type BrowserInput =
	| { kind: "text"; text: string }
	| { kind: "key"; key: string; modifiers: number }
	| {
			kind: "pointer";
			phase: "move" | "down" | "up";
			x: number;
			y: number;
			button: "left" | "right" | "middle";
			clicks: number;
	  }
	| { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number };

export function readBrowserInput(raw: Record<string, unknown>): BrowserInput {
	if (raw.kind === "text" && typeof raw.text === "string" && raw.text.length <= 16384)
		return { kind: "text", text: raw.text };
	if (
		raw.kind === "key" &&
		typeof raw.key === "string" &&
		/^(?:[a-zA-Z0-9]|Enter|Tab|Backspace|Delete|Escape|Arrow(?:Left|Right|Up|Down)|Home|End|PageUp|PageDown|Insert|F(?:[1-9]|1[0-2]))$/.test(
			raw.key,
		) &&
		typeof raw.modifiers === "number" &&
		Number.isInteger(raw.modifiers) &&
		raw.modifiers >= 0 &&
		raw.modifiers <= 15
	)
		return { kind: "key", key: raw.key, modifiers: raw.modifiers };
	const number = (value: unknown, max: number): value is number =>
		typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= max;
	if (number(raw.x, 3200) && number(raw.y, 2400) && raw.x >= 0 && raw.y >= 0) {
		if (raw.kind === "wheel" && number(raw.deltaX, 4000) && number(raw.deltaY, 4000))
			return { kind: "wheel", x: raw.x, y: raw.y, deltaX: raw.deltaX, deltaY: raw.deltaY };
		if (
			raw.kind === "pointer" &&
			["move", "down", "up"].includes(String(raw.phase)) &&
			(raw.button === "left" || raw.button === "right" || raw.button === "middle") &&
			(raw.clicks === 1 || raw.clicks === 2 || raw.clicks === 3)
		)
			return {
				kind: "pointer",
				phase: raw.phase as "move" | "down" | "up",
				x: raw.x,
				y: raw.y,
				button: raw.button,
				clicks: raw.clicks,
			};
	}
	throw new BrowserRequestError("Invalid browser input");
}
