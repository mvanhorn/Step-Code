# apps/web — StepCode Web host and React client

These rules add to the repository rules in `../../AGENTS.md` (commit attribution, Git safety, dependency security,
exec-plans, conversational style). Where the two disagree, this file wins for code under `apps/web/`.

`@step-harness/web` is two programs in one package:

- **Host** (`src/`): a loopback Node HTTP/SSE server that runs StepCode sessions through `@step-harness/coding-agent`
  and serves the built client.
- **Client** (`client/`): a React single-page app, the only UI of both StepCode Web and StepCode Desktop. The desktop
  app (`apps/desktop`) loads exactly this build; it has no UI of its own.

A change to the client is a change to the desktop app. Check both hosts when it matters (see Testing).

## Tech stack

| Area | Choice | Notes |
|---|---|---|
| Host runtime | Node.js (>= 22.19), `node:http`, no web framework | ESM, compiled by `tsgo -p tsconfig.json` to `dist/` |
| Agent | `@step-harness/coding-agent` | Sessions, tools, permissions, models. The host never reimplements them. |
| Client | React 19.3, react-dom 19.3 | Function components and hooks only |
| Build / dev server | Vite 8.2 + `@vitejs/plugin-react` | `vite.config.ts`: root `client/`, output `dist/public/` |
| State | Own store on `useSyncExternalStore` (`client/src/state/store.ts`) | No Redux, Zustand, React Query, router |
| Styling | Plain CSS per feature + CSS Modules for `ui/` primitives | **No Tailwind**, no CSS-in-JS, no UI kit |
| Markdown, highlighting, i18n | In-house (`lib/markdown.ts`, `features/files/highlight.ts`, `i18n/`) | No libraries |
| Types | TypeScript strict, `erasableSyntaxOnly`, `verbatimModuleSyntax` | Type-checked by `tsgo` (both tsconfigs) |
| Lint / format | Biome (root `biome.json`) | Tabs, indent width 3, line width 120, double quotes, semicolons |
| Tests | `node:test` + `tsx` (unit), headless Chrome over CDP (e2e) | No Jest, Vitest, Playwright |

The runtime dependencies are `react`, `react-dom` and the workspace `@step-harness/coding-agent`. Adding any dependency
needs the user's approval first; pin it to an exact version and install with `pnpm install --ignore-scripts`.

## Directory layout

```
apps/web/
  AGENTS.md / CLAUDE.md
  package.json           exports: ./server (dist/server.js), ./desktop-bridge (client contract, type-only)
  openapi.yaml           HTTP API description; copied to dist/ by `build`
  tsconfig.json          host (src/**), emits dist/
  tsconfig.client.json   client (client/src), noEmit, DOM libs, react-jsx
  vite.config.ts         client build + dev proxy (/api, /auth, /healthz -> host)
  src/                   HOST
    server.ts            HTTP routes, auth/Origin checks, SSE, static files from dist/public
    runtime.ts           session runtime: create/open/prompt/abort, snapshots, event fan-out
    approval.ts          ApprovalBroker: pending tool approvals per session
    workspaces.ts        workspace registry (newest first)
    files.ts             workspace file tree / read / search
    auth.ts, login.ts    cookie secret, launch-token exchange, credential status, desktop sign-in
    directory-picker.ts  server-side folder chooser
    settings.ts          settings back end: MCP servers, plugins/marketplaces, skills
    attachments.ts, feedback.ts, banner.ts, bootstrap.ts, writer-lease.ts
  client/
    index.html           <div id="root">, loads /src/main.tsx
    MIGRATION_MAP.md     legacy app.js -> React map (historical; this file is authoritative)
    src/
      main.tsx           CSS order, host attributes, theme/locale before first paint, render, bootstrap()
      App.tsx            page skeleton: mounts each feature's slot components
      platform/          desktop-bridge.ts (window.stepcodeDesktop contract), host.ts (host detection)
      state/             store.ts (AppState, setState/setUi, useAppStore), session.ts (lifecycle, SSE), types.ts
      lib/               pure helpers: api, format, markdown, storage, ime, clipboard
      i18n/              messages.ts (zh + en dictionaries), index.ts (t, useT)
      styles/global.css  design tokens (light/dark), reset, app grid, shared rules, [data-host] rules
      ui/                reusable primitives, one folder each (Component.tsx + Component.module.css), barrel index.ts
      features/<name>/   index.tsx (public slots), actions.ts (state changes), *.tsx, <name>.css
        composer conversation files login market settings shell sidebar workspace
  test/
    *.test.ts            host unit tests (node:test)
    e2e/web.e2e.mjs      builds the client, starts the host, drives headless Chrome
  dist/                  build output (server.js, public/, openapi.yaml); never edit
```

## Boundaries

- **Host and client never import each other.** The client talks to the host only over HTTP/SSE (`lib/api.ts`,
  `state/session.ts`). The client mirrors the wire types it needs in `state/types.ts`; keep them in sync with
  `src/runtime.ts` / `src/approval.ts` by hand when a payload changes.
- **The client imports no `packages/*` code.** Agent, session, prompt and tool semantics live in
  `@step-harness/coding-agent` and below; the client renders what the host sends.
- **The host stays thin.** Do not put agent-loop, prompt assembly, tool or permission logic in `src/`. Call the
  coding-agent APIs; translate their events into SSE. Pending approvals go through `ApprovalBroker`.
- **Desktop-only behaviour goes through the bridge.** Use `getDesktopBridge()` / `isDesktopHost()` from
  `platform/host.ts`, and always keep a browser fallback (e.g. folder picking: bridge, then the host's picker, then the
  in-page browser). Desktop-only CSS goes under `[data-host="desktop"]` in `styles/global.css`.
- `platform/desktop-bridge.ts` is a cross-package contract with `apps/desktop/src/preload.ts`. Change it only together
  with the desktop side (see `apps/desktop/AGENTS.md`).

## Client conventions

1. **Where code goes.**
   - A reusable, product-agnostic control goes to `ui/<Name>/` with a CSS Module, exported from `ui/index.ts`. `ui/`
     must not import from `features/`, `state/` or `i18n/`.
   - Product UI goes to `features/<name>/`. Other features use only what its `index.tsx` and `actions.ts` export;
     do not reach into another feature's components or CSS.
   - Shared state shape changes go to `state/store.ts` (`AppState` / `UiState` + initial value). Session and stream
     logic stays in `state/session.ts`.
   - A new top-level area is a new feature folder, mounted in `App.tsx` and documented in the `App.tsx` comment.
2. **State.** Read with `useAppStore(selector[, shallowEqual])`; write with `setState` / `setUi`. Never mutate store
   values: replace arrays, objects, Maps and Sets (`mapWith`, `mapWithout`, `setWith`, `setWithout`, `setToggled`).
   Keep selectors narrow so a stream update does not re-render the whole tree; memoise heavy rows (`memo`, `useMemo`).
3. **DOM contract.** Ids, class names, `data-*`, `aria-*` and roles that tests, `scripts/check-browser-smoke.mjs` or
   cross-feature CSS select on are an API. Do not rename or remove them; grep `test/e2e/web.e2e.mjs` and the smoke
   script before you do.
4. **Overlays stay mounted.** Popovers, modals, banners and panels toggle the native `hidden` attribute
   (`hidden={!open}`) or an `open` class; do not unmount them. Tests read `element.hidden`.
5. **Text.** Every user-visible string comes from `useT()` / `t()`. Add each new key to both the `zh` and the `en`
   dictionary in `i18n/messages.ts`. Do not reuse a key whose wording you need to change in only one place; add a
   new key.
6. **CSS.**
   - Use the tokens in `styles/global.css` (`--ink`, `--surface`, `--line`, `--focus-border`, `--control-h-md`,
     radii...) instead of literal colors and sizes, so light and dark themes both work.
   - Feature CSS keeps global class names (tests depend on them); CSS Modules are for `ui/` only.
   - Load order is global.css, then ui modules, then feature CSS.
   - Reuse the existing patterns: `data-tooltip` + `.list-action` / `.project-action` for hover tooltips (not
     `title`), `SearchInput` for search fields, `IconButton` for icon buttons.
7. **Accessibility.** Every `<button>` has `type`; icon-only buttons have `aria-label`. Clickable non-buttons need a
   role, `tabIndex` and a keyboard handler. Biome's a11y rules must pass.
8. **Inputs driven by tests.** The e2e suite sets `input.value` and dispatches a non-bubbling `input` event. React's
   `onChange` misses that; for such inputs use a native listener or `onInputCapture` on an uncontrolled input (see
   `ui/SearchInput`).
9. **Escape and global keys** are handled in one place, `features/shell/ShellEffects.tsx` (`handleEscape` closes the
   topmost overlay first). Add new overlays to that chain instead of adding document listeners.
10. **Icons** are `<symbol id="i-<name>">` entries in `ui/IconSprite/IconSprite.tsx`; add the name to `ICON_NAMES`
    and use `<Icon name>`.

## Host conventions

- Every route is under `/api/v1/` (plus `/auth/*`, `/healthz`). It must pass the auth cookie and Origin checks in
  `server.ts`; the server listens on `127.0.0.1` only. Never log the launch token or the cookie secret.
- Adding or changing a route or payload: update `openapi.yaml` in the same change, update `client/src/state/types.ts`,
  and add a unit test.
- Anything a reloaded page must show again belongs in the session snapshot (e.g. `pendingApprovals`), not only in
  an SSE event.
- Workspace navigation metadata is separate from sessions: `web-workspaces.json` stores registered `workspaces`
  and explicit `removedWorkspaces`. Removed entries are returned with `hidden: true`; clients must not recreate
  their project groups from session cwd values. Re-adding restores the group; removal never deletes chats or files.
- Environment variables: `STEPCODE_WEB_PORT` (default 3077), `STEPCODE_WEB_CWD` (default workspace),
  `STEPCODE_WEB_PUBLIC_DIR` (client directory), `STEPCODE_WEB_AUTH_SECRET`, `STEPCODE_WEB_OPEN` (below).
  Document new ones here and in `apps/desktop/README.md` if the desktop passes them through.
- Opening a browser on start is **opt-in**, because Desktop shows the client in its own window and the tests must stay
  headless. `STEPCODE_WEB_OPEN=1|true|on` makes the host open the launch URL right after printing the banner; unset or
  any other value leaves it closed. The developer commands set it; Desktop, the e2e suite and
  `scripts/check-web-runtime.mjs` force it to `"0"` so a variable exported in the caller's shell cannot open a window.
  `STEPCODE_WEB_OPEN_MARKER=<path>` names a file recording "this run already opened a tab", so the restarts `tsx watch`
  performs stay quiet; `web:watch` creates it in a per-run temporary directory and removes that directory on exit. One
  open per run is the right unit: the cookie a page holds survives a host restart (the signing secret is persisted), so
  the tab that is already open reconnects by itself.
- `/api/v1/settings/*` is the settings screen's own surface (MCP servers, plugins, marketplaces, skills). It reads
  and writes the user's global StepCode configuration through `@step-harness/coding-agent` — the same files
  `step mcp`, `/plugin` and the TUI resource selector use — and never project scope. Only user-scope state moves;
  a change reaches a session when that session starts (MCP servers connect at `session_start`, skills load with its
  resources), so the client says so instead of reloading sessions.
- Do not depend on `process.cwd()` being the workspace; the desktop starts the server elsewhere (macOS privacy
  blocks a cwd inside `~/Documents`).

## Commands

Run from the repo root.

| Command | Use |
|---|---|
| `pnpm web` | Build the client, run the host from source with the current folder as workspace (port 3077), and open the launch URL in the default browser (`STEPCODE_WEB_OPEN=0` to skip) |
| `pnpm web:watch` | Same as `pnpm web`, but rebuilds the client and restarts the host on every source change (web or imported packages); refresh the page to see it. A host restart drops running turns. The browser opens once per run, not on each restart |
| `pnpm --filter @step-harness/web dev:client` | Vite dev server with HMR, proxies to a host on `STEPCODE_WEB_PORT` (start the host first) |
| `pnpm --filter @step-harness/web typecheck` | Host and client type check |
| `pnpm --filter @step-harness/web test` | Host unit tests |
| `TSX_TSCONFIG_PATH=../../tsconfig.json node --import tsx --test test/<name>.test.ts` | One unit test file (from `apps/web/`); without the tsconfig, workspace packages resolve to `dist/` and fail |
| `pnpm --filter @step-harness/web test:e2e` | Client build + e2e in headless Chrome (`CHROME_PATH` to override; skipped without Chrome) |
| `pnpm run check` | Required before handing back any code change: Biome, guards, type checks, web unit tests, web runtime, browser smoke, desktop type check |

`pnpm run check` runs `biome check --write`, so it may reformat files; review the diff afterwards. The packages the
host imports must be built (`pnpm build` at the root) before the host runs.

## Testing

- Host change: add or update a unit test in `test/` and run it.
- Client change: `typecheck`, then `test:e2e` when the change touches a tested surface (sidebar, workspace, files,
  preview, settings, auth). Then check the real UI in a visible browser, and say what you checked.
- Change that affects a session (streaming, approvals, tools, file edits): run one real turn that edits a file in a
  scratch workspace and confirm the change on disk, in Web and, when the client or host changed, in Desktop
  (`pnpm desktop`).
- Never point manual tests at a real project folder without the user's say-so; use a scratch folder.
- Do not kill a host you did not start (e.g. a user's server on port 3077); pick another port.

## Do not

- Add Tailwind, a CSS-in-JS library, a component kit, a state library, a router or a Markdown library.
- Edit `dist/`, or reintroduce the deleted vanilla client (`public/app.js`).
- Put UI strings in only one language, or hard-code colors that the theme tokens cover.
- Use `any`, inline/dynamic imports, `enum`, `namespace` or parameter properties.
- Change `desktop-bridge.ts` without the matching desktop change.
