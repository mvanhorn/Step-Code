import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Whether this process should open the launch URL in a browser by itself.
 *
 * The host is started by several callers that must stay silent: StepCode
 * Desktop (it shows the client in its own window), the e2e suite, and
 * `scripts/check-web-runtime.mjs`. So opening is opt-in, and only the developer
 * commands `pnpm web` / `pnpm web:watch` set it.
 *
 * `pnpm web:watch` restarts the host on every source change, and each restart
 * would open another tab for a page that is already connected — the cookie it
 * holds survives the restart. `STEPCODE_WEB_OPEN_MARKER` names a file that
 * records "already opened for this run", so a restart stays quiet.
 */

/** `1`, `true` or `on` opens the browser. Unset or anything else leaves it closed. */
export const OPEN_ENV = "STEPCODE_WEB_OPEN";

/** Per-run marker file: when it exists, the browser was already opened. */
export const OPEN_MARKER_ENV = "STEPCODE_WEB_OPEN_MARKER";

function isEnabled(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "on";
}

/**
 * `markerExists` is injected so the decision can be asserted without touching
 * the filesystem.
 */
export function shouldOpenBrowser(environment: NodeJS.ProcessEnv, markerExists: (path: string) => boolean): boolean {
	if (!isEnabled(environment[OPEN_ENV])) return false;
	const marker = environment[OPEN_MARKER_ENV]?.trim();
	return marker === undefined || marker === "" || !markerExists(marker);
}

/**
 * Record that this run opened its tab, so a `web:watch` restart does not open
 * another. Best effort: an unwritable temporary directory costs one extra tab,
 * which is not a reason to fail startup.
 */
export function recordBrowserOpened(environment: NodeJS.ProcessEnv): void {
	const marker = environment[OPEN_MARKER_ENV]?.trim();
	if (marker === undefined || marker === "") return;
	try {
		mkdirSync(dirname(marker), { recursive: true });
		writeFileSync(marker, "");
	} catch {
		// See above: the next restart opens a redundant tab instead.
	}
}
