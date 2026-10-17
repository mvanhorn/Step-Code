/**
 * The startup banner printed once the Web server is listening.
 *
 * Modelled on the shape other local web UIs use — a headline, then aligned
 * label/value rows — so the one thing a user needs (the launch URL) is the
 * easiest thing to find. Kept as a pure function so the layout can be asserted
 * without starting a server.
 */

/** Indent before every line, so the block reads as one unit. */
const INDENT = "  ";

/** Every value starts at the same column, whatever the label length. */
const LABEL_WIDTH = 9;

export interface StartupBannerInput {
	readonly port: number;
	readonly token: string;
	readonly version: string;
}

function row(label: string, value: string): string {
	return `${INDENT}${label.padEnd(LABEL_WIDTH)} ${value}`;
}

/**
 * The URL that signs a browser in. The token is single-use — the page trades it
 * for a cookie — so this is the only way a fresh browser gets in.
 */
export function launchUrl(port: number, token: string): string {
	return `http://127.0.0.1:${port}/#token=${token}`;
}

/** Names the port of a dev server (Vite) that serves the client and proxies to this host. */
export const CLIENT_PORT_ENV = "STEPCODE_WEB_CLIENT_PORT";

/**
 * The port the launch URL points at. `pnpm web:watch` serves the client from
 * the Vite dev server for hot module replacement, so the link must open that
 * server, not the host; the Vite proxy rewrites Origin to the host's, so the
 * token exchange and the cookie still pass the host's checks.
 *
 * An invalid value throws: silently falling back to the host port would open a
 * page without HMR and hide the misconfiguration.
 */
export function resolveLaunchPort(environment: NodeJS.ProcessEnv, hostPort: number): number {
	const raw = environment[CLIENT_PORT_ENV]?.trim();
	if (raw === undefined || raw === "") return hostPort;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1 || value > 65_535) {
		throw new Error(`${CLIENT_PORT_ENV} must be a port number between 1 and 65535, got "${raw}"`);
	}
	return value;
}

export function formatStartupBanner({ port, token, version }: StartupBannerInput): string {
	const url = launchUrl(port, token);
	return [
		`${INDENT}StepCode Web ready  ${version}`,
		`${INDENT}Local web UI is available from this machine.`,
		"",
		row("Local:", url),
		// No host flag exists yet, so the hint says what is actually true rather
		// than advertising an option the server does not have.
		row("Network:", "off  bound to 127.0.0.1"),
		"",
		row("Token:", token),
		"",
		row("Stop:", "Ctrl+C"),
	].join("\n");
}
