#!/usr/bin/env node
/**
 * `pnpm web` with automatic rebuilds: the same host and client, but edits apply
 * without a manual restart.
 *
 * - Client (`apps/web/client`): `vite build --watch` rewrites `dist/public`; the
 *   host serves it from disk with `index.html` revalidated, so a page refresh
 *   shows the change.
 * - Host (`apps/web/src`) and the workspace packages it imports from source
 *   (root tsconfig paths): `tsx watch` restarts the host process. A restart
 *   drops running turns and SSE streams; the page reconnects.
 *
 * The first client build runs to completion before the host starts, so the
 * first page load never sees an empty `dist/public`.
 *
 * The browser opens once per run: the host opens it on its first start and
 * records a marker file, so the restarts `tsx watch` performs on every edit do
 * not open another tab for a page that is already connected.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = join(repoRoot, "apps", "web");
const useShell = process.platform === "win32";
/** Removed on exit; only ever holds the open-once marker. */
const markerDir = mkdtempSync(join(tmpdir(), "stepcode-web-open-"));
const env = {
	...process.env,
	STEPCODE_WEB_CWD: process.env.STEPCODE_WEB_CWD ?? process.cwd(),
	STEPCODE_WEB_OPEN: process.env.STEPCODE_WEB_OPEN ?? "1",
	STEPCODE_WEB_OPEN_MARKER: join(markerDir, "opened"),
};

const initial = spawnSync("pnpm", ["exec", "vite", "build"], { cwd: webDir, stdio: "inherit", env, shell: useShell });
if (initial.status !== 0) process.exit(initial.status ?? 1);

const children = [
	spawn("pnpm", ["exec", "vite", "build", "--watch"], { cwd: webDir, stdio: "inherit", env, shell: useShell }),
	spawn("pnpm", ["exec", "tsx", "watch", "--clear-screen=false", "--tsconfig", "../../tsconfig.json", "src/server.ts"], {
		cwd: webDir,
		stdio: "inherit",
		env,
		shell: useShell,
	}),
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
	// Either watcher ending means the dev loop is broken; take the other one down too.
	child.on("exit", (code, signal) => stop(code ?? (signal ? 1 : 0)));
	child.on("error", (error) => {
		console.error(error.message);
		stop(1);
	});
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(0));
