#!/usr/bin/env node
/**
 * `pnpm web` with client hot module replacement.
 *
 * - Client (`apps/web/client`): the Vite dev server serves it from source with
 *   HMR and proxies `/api`, `/auth` and `/healthz` to the host. An edit shows up
 *   in the open page without a refresh.
 * - Host (`apps/web/src`) and the workspace packages it imports: run once with
 *   `tsx`, not watched. A StepCode Web agent that edits this repository would
 *   otherwise restart the host on its own edit and drop its running turn (and
 *   a half-written file crashes the restart). Restart `pnpm web:watch` to pick
 *   up host or package changes, or set `STEPCODE_WEB_WATCH_HOST=1` to restart
 *   the host on every change as before.
 *
 * The host prints and opens a launch URL on the Vite port
 * (`STEPCODE_WEB_CLIENT_PORT`, default 5173), so the token exchange runs
 * through the proxy and the cookie lands on the page that has HMR.
 *
 * The browser opens once per run: the host opens it on its first start and
 * records a marker file, so a watched host restart does not open another tab.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = join(repoRoot, "apps", "web");
const useShell = process.platform === "win32";
const watchHost = /^(?:1|true|on)$/iu.test(process.env.STEPCODE_WEB_WATCH_HOST?.trim() ?? "");
const clientPort = process.env.STEPCODE_WEB_CLIENT_PORT?.trim() || "5173";
/** Removed on exit; only ever holds the open-once marker. */
const markerDir = mkdtempSync(join(tmpdir(), "stepcode-web-open-"));
const env = {
	...process.env,
	STEPCODE_WEB_CWD: process.env.STEPCODE_WEB_CWD ?? process.cwd(),
	STEPCODE_WEB_OPEN: process.env.STEPCODE_WEB_OPEN ?? "1",
	STEPCODE_WEB_OPEN_MARKER: join(markerDir, "opened"),
	STEPCODE_WEB_CLIENT_PORT: clientPort,
};

const hostArgs = watchHost
	? ["exec", "tsx", "watch", "--clear-screen=false", "--tsconfig", "../../tsconfig.json", "src/server.ts"]
	: ["exec", "tsx", "--tsconfig", "../../tsconfig.json", "src/server.ts"];

const children = [
	// --strictPort: the launch URL names this exact port, so Vite must not move to another one.
	spawn("pnpm", ["exec", "vite", "--host", "127.0.0.1", "--port", clientPort, "--strictPort"], {
		cwd: webDir,
		stdio: "inherit",
		env,
		shell: useShell,
	}),
	spawn("pnpm", hostArgs, { cwd: webDir, stdio: "inherit", env, shell: useShell }),
];

let stopping = false;
function stop(code) {
	if (stopping) return;
	stopping = true;
	for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
	try {
		rmSync(markerDir, { recursive: true, force: true });
	} catch {
		// A leftover empty marker directory in the temp folder is harmless.
	}
	process.exitCode = code;
}

for (const child of children) {
	// Either process ending means the dev loop is broken; take the other one down too.
	child.on("exit", (code, signal) => stop(code ?? (signal ? 1 : 0)));
	child.on("error", (error) => {
		console.error(error.message);
		stop(1);
	});
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(0));
