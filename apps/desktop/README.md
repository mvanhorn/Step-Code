# StepCode Desktop

`@step-harness/desktop` is an Electron shell around the StepCode web app. It does not have its own UI or agent
runtime: it starts the same server that `pnpm web:serve` runs (`apps/web/dist/server.js`) and shows the same React
client (`apps/web/dist/public`) in a native window. Sessions, workspaces, settings and credentials are the ones the
CLI and the web host use (`~/.stepcode`), so a conversation started in one is visible in the others.

What the shell adds on top of the browser version:

- No terminal or browser needed: the server runs under Electron's bundled Node (`ELECTRON_RUN_AS_NODE=1`).
- `window.stepcodeDesktop` (contract: `apps/web/client/src/platform/desktop-bridge.ts`, imported as
  `@step-harness/web/desktop-bridge`): native folder picker, open http(s) links in the system browser, reveal a path
  in Finder / Explorer. The client checks for it and otherwise falls back to the server's picker / in-page browser.
- The user's login-shell environment (macOS / Linux GUI launches), so the agent's bash tool finds the same `git`,
  `node`, Homebrew tools, etc. as in a terminal.
- Native menus (copy/paste/undo, zoom, fullscreen, DevTools), edit context menu, persisted window bounds,
  single-instance lock, macOS inset traffic lights.

## Architecture

```
Electron main (src/main.ts)
 ├─ server-host.ts ── spawn ──▶ <electron as node> apps/web/dist/server.js
 │     env: STEPCODE_WEB_PORT=<free loopback port>, STEPCODE_WEB_CWD=<workspace>, STEPCODE_WEB_OPEN=0, ELECTRON_RUN_AS_NODE=1
 │          (STEPCODE_WEB_OPEN=0: the window shows the client, so the server must not open a browser tab too)
 │     stdout "Local: http://127.0.0.1:<port>/#token=<launch token>"  ──▶ parsed (redacted in the log)
 │     stdout/stderr ──▶ <logs>/web-server.log
 ├─ window.ts ── BrowserWindow (contextIsolation, sandbox, no nodeIntegration)
 │     loads http://127.0.0.1:<port>/#token=<token>; the client exchanges it for its auth cookie
 │     navigation pinned to that origin; other http(s) links ──▶ system browser
 ├─ preload.ts (dist/preload.cjs) ── contextBridge ──▶ window.stepcodeDesktop
 └─ ipc.ts ── pickDirectory / openExternal / revealPath
       (only from the window's top frame on the server origin)
```

On quit the server gets SIGTERM, then SIGKILL after 5 s. If it fails to start or exits unexpectedly the window shows
an error page; **File → Restart Server** starts a new one.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm --filter @step-harness/desktop start` | Build `@step-harness/web`, bundle the desktop, launch Electron. |
| `pnpm --filter @step-harness/desktop dev` | Bundle the desktop and launch; builds the web app only if its output is missing. |
| `pnpm --filter @step-harness/desktop build` | esbuild: `src/main.ts` → `dist/main.js` (ESM), `src/preload.ts` → `dist/preload.cjs`. |
| `pnpm --filter @step-harness/desktop typecheck` | `tsgo --noEmit`. |

The packages the server imports (`@step-harness/coding-agent` and below) must be built (`pnpm build` at the root).

## Environment variables

| Variable | Effect |
| --- | --- |
| `STEPCODE_WEB_CWD` | Default workspace. Otherwise the last folder picked with the native picker, else the home directory. |
| `STEPCODE_DESKTOP_NODE` | Run the server with this Node.js executable instead of Electron's (e.g. for a native-module ABI mismatch). |
| `STEPCODE_DESKTOP_SERVER_ENTRY` | Use another `server.js` build instead of `@step-harness/web/server`. |
| `STEPCODE_WEB_PUBLIC_DIR` | Passed through to the server: serve the client from another directory. |
| `STEPCODE_STEPGO_IMPORT` | Passed through to the server: `0` skips the one-time import of a local stepgo launcher's models and key (see `docs/step-configuration.md`). |
| `STEPCODE_DESKTOP_PORT` | Fixed server port instead of a free one. |
| `STEPCODE_DESKTOP_START_TIMEOUT_MS` | How long to wait for the server banner (default 30000). |
| `STEPCODE_DESKTOP_SHELL_ENV` | `0` skips the login-shell environment read; `1` forces it even when started from a terminal. |
| `STEPCODE_DESKTOP_SHELL_ENV_TIMEOUT_MS` | Deadline for that read (default 8000). |
| `STEPCODE_DESKTOP_USER_DATA_DIR` | Isolated Electron profile (window state, logs, single-instance lock). |
| `STEPCODE_DESKTOP_SMOKE` | `1`: load the app hidden, print `STEPCODE_DESKTOP_SMOKE {json}` (bridge, auth, `/healthz`), exit 0/1. |

Electron switches such as `--remote-debugging-port=9222` can be appended to `electron .`.

## Files

- Window bounds and last picked folder: `<userData>/desktop-state.json` (macOS: `~/Library/Application Support/StepCode`).
- Server log: `<logs>/web-server.log` (macOS: `~/Library/Logs/StepCode`), also **File → Show Server Logs**.

## Desktop CSS hooks

The client marks `<html data-host="desktop" data-platform="darwin|win32|linux">` when the bridge is present. On macOS
the window uses `titleBarStyle: "hiddenInset"` with the traffic lights at `{ x: 16, y: 16 }`; the client reserves the
top-left strip of the sidebar for them and marks it `-webkit-app-region: drag`.

## Not included yet

Packaging (installers, code signing, notarization), auto-update and app icons. `electron .` runs the app from the
workspace only.
