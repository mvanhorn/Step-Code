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
