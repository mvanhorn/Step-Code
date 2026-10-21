# StepCode Web client: migration map

> Historical record of the port (finished 2026-10-14; the legacy files are deleted). For current conventions, tech
> stack and layout, `apps/web/AGENTS.md` is authoritative; where this map disagrees (e.g. section 1, item 10 on Biome
> config), follow `AGENTS.md`.

This file is the coordination contract for porting the legacy vanilla-JS client
(`apps/web/public/{index.html,app.js,styles.css}`, backup in
`/tmp/stepcode-legacy-web/public/`) to the React 19 + Vite client in
`apps/web/client/`. Every legacy line has exactly one owner below. Feature agents
work only inside `client/src/features/<feature>/`; everything else is Foundation.

Owners: `foundation` | `shell` | `sidebar` | `workspace` | `files` | `conversation` | `composer`.

Behaviour, look, strings, localStorage keys and API calls stay 1:1 with the legacy
code. Read the legacy lines you own in full before porting them.

---

## 1. Layout and conventions

```
client/
  index.html                 Vite entry, <div id="root">, loads /src/main.tsx
  src/
    main.tsx                 CSS order, host attrs, theme/locale before first paint, render, bootstrap()
    App.tsx                  legacy page skeleton; mounts each feature's slot components
    platform/desktop-bridge.ts   window.stepcodeDesktop contract (do not change)
    platform/host.ts         getDesktopBridge(), isDesktopHost(), applyHostAttributes()
    i18n/                    messages.ts (legacy dictionaries), index.ts (t, useT, ...)
    lib/                     api, markdown, format, storage, ime, clipboard (pure)
    state/                   store.ts (AppState + store), session.ts (lifecycle), types.ts
    styles/global.css        tokens, theme, reset, app grid, shared rules, desktop rules
    ui/                      reusable primitives, CSS Modules, barrel ui/index.ts
    features/<feature>/      index.tsx (slot components), actions.ts (if any), *.tsx, *.css
```

### Conventions (all features)

1. **DOM contract.** Keep every legacy id, class name, `data-*` attribute,
   `aria-*` attribute, `role`, and element type that tests or CSS use.
   `apps/web/test/e2e/web.e2e.mjs` reads: `#authBanner`, `#workspaceButtonName`,
   `#userMenuButton` (+ `use[href='#i-settings']`), `#userPopover`, `#themeMenuItem`
   (+ its `span`), `#themeSubmenu`, `[data-theme-choice]`, `#themeValue`,
   `#languageMenuItem`, `#languageSubmenu`, `[data-language-choice]`,
   `#fileTree.open`, `#fileTreeName`, `#fileTreeBody .file-row[data-path][data-kind]`
   (+ `aria-expanded`, `aria-level`, `.file-detail`, `.active`), `#fileTreeBody .empty-list`,
   `#fileTreeRefresh`, `#fileTreeSearch`, `#fileTreeBack`, `#previewPanel`, `.app.preview-open`,
   `#previewTabs .preview-tab` (+ `.active`, `.preview-tab-close`), `#previewPath`,
   `#previewBody .code-view(.wrap) .code-line`, `.tok-*`, `#previewWrap[aria-pressed]`,
   `#previewMode`, `#previewReload`, `#previewCopy`, `#previewShow`,
   `#previewBody .preview-markdown h2/strong`, `#previewBody img.preview-image`,
   `#previewBody .preview-message`, `#addWorkspace` (`data-tooltip`, `aria-busy`),
   `#workspaceBrowserModal`, `#workspacePathInput`, `#workspaceParentButton`,
   `.workspace-directory-item`, `#workspaceBrowserConfirm`, `#errorToast`,
   `#projectGroups .project-group[data-cwd]`, `.project-name`, `.tree-button`,
   `.remove-workspace`, `.project-sessions .empty-list`.
2. **Hidden attribute.** Overlays, popovers, banners and panels stay mounted and
   toggle the native `hidden` attribute (`hidden={!open}`); never unmount them.
   Tests read `element.hidden`. `[hidden] { display: none !important }` is global.
3. **Immutable state.** Never mutate anything read from the store. Replace Maps,
   Sets, arrays and objects (`mapWith`, `mapWithout`, `setWith`, `setWithout`,
   `setToggled` in `state/store.ts`).
4. **CSS.** Port the legacy rules you own (section 4) verbatim into plain `.css`
   files next to your components (e.g. `features/sidebar/sidebar.css`), imported by
   your `index.tsx`. Keep the legacy global class names; do not convert them to
   CSS Modules (tests and cross-feature selectors depend on the names). CSS load
   order is global.css → ui modules → feature CSS, so your legacy rules override a
   primitive's module styles where both apply.
5. **Text.** All UI strings come from `useT()` / `t()` with the legacy keys.
   Strings the legacy code hard-coded in Chinese (e.g. `"无输入摘要"`,
   `"运行错误"`, `"路径："`, model meta `"K 上下文"`, `aria-label="会话操作"`,
   `title="收起侧边栏 ⌘B"`) stay hard-coded exactly as they were.
6. **Native input events in tests.** The e2e test sets `input.value = ...` and
   dispatches `new Event("input")` on `#fileTreeSearch`. React `onChange` does
   not fire for that, and because the event does not bubble, neither does the
   root-delegated `onInput`. Use a native listener on the element (as
   `FileTreePanel` does) or `onInputCapture` on an uncontrolled input
   (`defaultValue` + ref to reset). Same for any input a test drives this way.
7. **Clickable non-buttons** need a keyboard handler (`onKeyDown`) and a role /
   tabIndex as the legacy markup had (session rows, tree rows, preview tabs,
   task banner). Biome a11y rules apply.
8. **No new dependencies.** React, react-dom, Vite and the plugin are all there is.
9. **Shared code is read-only for feature agents.** If you need a change in
   `ui/`, `lib/`, `state/`, `i18n/`, `styles/`, `App.tsx` or `main.tsx`, make the
   smallest additive change and report it in `openIssues`.
10. **Formatting.** Biome: tabs, indent width 3, line width 120, double quotes,
    semicolons, `type` on every `<button>`. Check with
    `pnpm exec biome check --config-path=<dir with a biome.json that includes client/> apps/web/client`
    until the root config includes the folder.

---

## 2. Shared APIs (Foundation)

### 2.1 Store — `state/store.ts`

```ts
appStore: Store<AppState>          // getState(), setState(patch | (s) => patch), subscribe(fn)
getState(), setState(patch | fn)   // shallow merge into AppState; no-op when nothing changed
setUi(patch | (ui) => patch)       // merge into state.ui
setTree((tree) => tree)            // replace state.tree
setPreview((preview) => preview)   // replace state.preview
useAppStore(selector, isEqual = Object.is)   // React hook (useSyncExternalStore)
shallowEqual                       // pass as isEqual when the selector builds an object
emptyTree(cwd?)                    // a fresh TreeState
mapWith / mapWithout / setWith / setWithout / setToggled   // immutable collection helpers
```

`AppState` (legacy `state`, app.js 1-53):

| field | legacy | notes |
|---|---|---|
| `sessions`, `current`, `timelineItems` | same | `current` is the open `SessionSnapshot` |
| `bootstrapCwd`, `draftCwd`, `draftPolicy`, `draftModel` | same | `draftModel` = `` `${provider}\u0000${id}` `` |
| `statusById`, `unreadById` | same | ReadonlyMap |
| `foldedProjects` | same | ReadonlySet of cwd |
| `groups`, `tags`, `currentView`, `currentFilter` | same | `tags`: session id → TagColor |
| `login`, `directoryPicker`, `pickingFolder` | same | |
| `workspaceBrowser: { path, parent, directories }` | `workspaceBrowserPath/Parent`, `workspaceDirectories` | |
| `tree`, `treeExpandedByCwd` | same | keep `treeExpandedByCwd.get(tree.cwd) === tree.expanded` (files/actions does) |
| `workspaces` | same | |
| `preview: { tabs, active, open, wrap }` | same | `wrap` initialised from `stepcode.previewWrap` |
| `showArchived`, `policiesCache`, `modes`, `goalDraft`, `attachments` | same | |
| `theme`, `locale` | same | initialised from `stepcode.theme` / `stepcode.locale` |
| `ui` | DOM toggles | see below |
| `toast` | `#errorToast` text/tone | set by `showError` |

Legacy fields that became feature-local (`useState` in the owning feature):
`tagTarget` → `ui.tagPicker.sessionId`; `searchResults`, `searchIndex` → sidebar
search modal; `modelPanelView` → composer model picker; `feedback` → conversation
feedback modal; `errorTimer`, `stream` → module variables in `state/session.ts`.

`state.ui` (replaces imperative DOM toggles; any feature may set these):

| field | legacy DOM | renders it |
|---|---|---|
| `sidebarHidden` | `.app.sidebar-hidden` (initial: `?sb=0`) | App |
| `sidebarWidth` | inline `--sidebar-width` on `.app` (null = CSS default) | App; set by sidebar |
| `previewWidth` | inline `--preview-width` on `.app` (null = CSS default) | App; set by files |
| `resizing` | `.app.resizing` | App; set by sidebar and files |
| `fileTreeOpen` | `#fileTree.open` | files |
| `searchOpen` | `#searchModal` visible | sidebar |
| `workspacePopoverOpen` | `#workspacePopover` visible, `#workspaceButton[aria-expanded]` | workspace |
| `workspaceBrowserOpen` | `#workspaceBrowserModal` visible | workspace |
| `userMenuOpen` | `#userPopover` visible, `#userMenuButton[aria-expanded]` | shell |
| `preferenceSubmenu` | `#themeSubmenu` / `#languageSubmenu` visible | shell |
| `sessionMenu: {sessionId,x,y} \| null` | `#sessionMenu` | sidebar |
| `tagPicker: {sessionId,anchorRight,anchorBottom} \| null` | `#tagPicker` | sidebar |
| `authExpired` | `#authBanner` visible | shell |
| `promptFocusRequest` | `$("#prompt").focus()` | composer focuses `#prompt` whenever it increments |
| `midView: "cron" \| "market" \| null` | `.market-view.open` on `#cronView` / `#marketView` (remote 4aea0f8) | market; opened from the sidebar entries, closed by Escape (shell chain) |

`.app.preview-open` is derived from `preview.open` (App). `#previewShow` hidden =
`preview.open || !preview.tabs.length` (files). `#workspaceControl` hidden =
`Boolean(current)` (workspace). `#stopRun` hidden = `current?.status !== "running"`;
`#prompt` and `#sendButton` disabled = `current?.status === "waiting"` (composer).

### 2.2 Session lifecycle — `state/session.ts`

| export | legacy | behaviour |
|---|---|---|
| `showError(message, danger = true)` | 3184-3193 | toast for 4.2 s; `danger=false` = neutral tone |
| `showAuthBanner()` | 689-692 | `ui.authExpired = true`; also run on every 401 by `lib/api` |
| `copyText(value, successText = t("copied"))` | 2098-2105 | clipboard + toast |
| `sessionTitle(session)` | 719-725 | |
| `taskStatus(state, session)` | 731-737 | |
| `knownWorkspaces(state)` | 1082-1095 | |
| `activeCwd(state?)` | 3399, 3617 | `current?.cwd \|\| draftCwd \|\| bootstrapCwd` |
| `modelKey(model)` | 2584 | |
| `mergeSessionSummary(sessions, snapshot)` | 2345-2352 | pure; returns the new list |
| `timelineFromEntries(entries)` | 2055-2096 | pure |
| `renderSnapshot(snapshot)` | 2992-3011 | sets current, policiesCache, draft*, status/unread, sessions, timeline |
| `connectStream(id)`, `closeStream()` | 3013-3109 | SSE `snapshot` / `agent` / `status` / `approval_required` / `web_error` |
| `refreshSessions()`, `refreshCurrent()`, `refreshWorkspaces()` | 3111-3120, 1984-1987 | reject on HTTP errors (callers decide) |
| `openSession(id)` | 3122-3130 | |
| `startDraft(cwd = bootstrapCwd)` | 3132-3151 | also `requestPromptFocus()` |
| `requestPromptFocus()` | — | increments `ui.promptFocusRequest` |
| `createSessionIfNeeded()` | 3153-3182 | |
| `interruptCurrent()` | 3245-3254 | |
| `exchange()`, `bootstrap({ openTree })` | 694-707, 3886-3919 | `bootstrap` runs once per page (StrictMode-safe); main.tsx calls it |

`populateModels` (2987-2990) dissolved: the composer renders the model picker from
`state.current`. All other legacy `render*()` calls after state changes are
replaced by React re-rendering.

### 2.3 Cross-feature actions (fixed names)

Foundation implemented these from the legacy code; the owning feature may refine
the bodies but must keep names and signatures.

| module | export | legacy |
|---|---|---|
| `features/files/actions.ts` | `openTree(project: { cwd })` | 1368-1392 |
| | `closeTree()` | 3496-3498, 3640-3641 |
| | `refreshTree()` | 1395-1412 |
| | `revealInTree(path)` | 1429-1440 |
| | `openFile(cwd, path)` | 1724-1744 |
| | extra: `loadTreeDirectory(path)`, `toggleTreeDirectory(path, expand?)`, `loadPreviewTab(cwd, path)`, `setPreviewOpen(open)`, `subscribeTreeSignals(fn)` | 1348-1366, 1414-1426, 1746-1758, 1717-1722 |
| `features/workspace/actions.ts` | `refreshWorkspaces()` (re-export of session.ts) | 1984-1987 |
| | `addWorkspace(path)` | 1990-2003 |
| | `removeWorkspace(path)` | 2040-2053 |
| | `chooseWorkspaceFolder()` | 2014-2038 (+ desktop bridge first) |
| | `openWorkspaceBrowser()` | 1180-1185 |
| | extra: `loadWorkspaceDirectory(path)` | 1164-1178 |
| `features/sidebar/actions.ts` | `openSearch()`, `closeSearch()` | 1199-1211 |
| `features/shell/actions.ts` | `toggleUserMenu(force?)` | 3195-3201 |
| | `applyTheme(theme, persist = true)`, `applyLocale(locale, persist = true)` | 559-566 |
| | extra: `resolvedTheme(theme?)`, `watchSystemTheme()` | 524-526, 3647-3649 |

`subscribeTreeSignals` delivers `{type:"reset-search", focus}` (clear
`#fileTreeSearch`, focus it when `focus`) and `{type:"reveal", path}` (scroll the
row into view and focus it), the DOM work `openTree` / `revealInTree` did inline.

`chooseWorkspaceFolder` order: `window.stepcodeDesktop.pickDirectory` (desktop
shell) → `POST /api/v1/workspaces/pick` when `directoryPicker === "native"` →
in-page browser. Errors from either native path fall back to the in-page browser
with the `folderPickerFailed` toast. `pickingFolder` drives `#addWorkspace[aria-busy]`.

### 2.4 Slot components (App.tsx)

App mounts these named exports at their legacy DOM positions:

| feature | `index.tsx` exports | legacy element(s) |
|---|---|---|
| sidebar | `SidebarNav` (fragment: `.brand-row`, `nav.sidebar-actions`, `section.conversation-list`), `SidebarResizer`, `SessionMenu`, `TagPicker`, `SearchModal` | inside `aside.sidebar`; `#sidebarResizer`; in `main`; after `.app` |
| files | `FileTreePanel`, `PreviewShowButton`, `PreviewPanel` | `#fileTree` (in sidebar); `#previewShow`; `aside#previewPanel` |
| shell | `UserArea`, `SidebarShowButton`, `ErrorToast`, `AuthBanner`, `ShellEffects` | `.user-area`; `#sidebarShow`; `#errorToast`; `#authBanner`; document listeners |
| conversation | `TaskBanner`, `ConversationStream`, `FeedbackModal` | `#taskBanner`; `#stream`; `#feedbackModal` |
| composer | `Composer({ workspaceControl })` | `form#composer` inside `.composer-zone` (App renders the zone) |
| market | `CronView`, `MarketView` | `#cronView`, `#marketView` in `main`, after `#taskBanner` |
| workspace | `WorkspaceControl`, `WorkspaceBrowserModal` | `#workspaceControl` (passed into the composer form); `#workspaceBrowserModal` |

App renders: `svg.icon-sprite`, `div.app` (classes + CSS vars), `aside.sidebar`,
`main.main`, `div.composer-zone`, and the slot order of legacy index.html.

### 2.5 i18n — `i18n/`

```ts
t(key, values?)            // current store locale; zh-CN fallback, then the key itself
tOr(key, fallback)         // legacy tOr
useT()                     // hook: (key, values?) => string; re-renders on locale change
useLocale()
translate(locale, key, values?)
formatRelativeTime(value)  // relativeTime with t("justNow")
I18nProvider               // mirrors locale into <html lang> (App wraps everything in it)
TAG_COLOR_NAMES, LOCALES, type Locale, type MessageKey, type TagColor
```

Legacy `[data-i18n]`, `[data-i18n-placeholder]`, `[data-i18n-title]` (title +
aria-label) become `{t(key)}`, `placeholder={t(key)}`,
`title={t(key)} aria-label={t(key)}`. Note `t("defaultModel")` has no entry and
renders the key itself, exactly as legacy (2616).

### 2.6 lib/

| module | exports | legacy |
|---|---|---|
| `api.ts` | `api(path, init)`, `apiSend(path, method, body?)`, `workspaceApi(cwd, endpoint, params)`, `errorMessage(e)`, `setUnauthorizedHandler` | 671-682, 1332-1334 |
| `markdown.ts` | `escapeHtml`, `contentText`, `renderMarkdown(value, { code, copy })` | 603-650 |
| `format.ts` | `compact`, `toolInputSummary`, `basename`, `relativeTime(value, justNowLabel)`, `formatTokens`, `formatBytes`, `ancestorPaths`, `cx`, `isMacPlatform` | 652-669, 709-717, 739-747, 1337-1342, 1711-1715, 2309-2313 |
| `storage.ts` | `STORAGE_KEYS`, `readStorage`, `writeStorage`, `removeStorage`, `readStoredInt` | localStorage calls |
| `ime.ts` | `useImeGuard()` (hook: `handlers`, `isComposing(e)`), `enterGuard(el)` | 3550-3574 |
| `clipboard.ts` | `writeClipboard(text)` | (see `copyText`) |

`STORAGE_KEYS`: `stepcode.theme`, `stepcode.locale`, `stepcode.previewWrap`,
`stepcode.previewWidth`, `stepcode.sidebarWidth`, `stepcode.pinnedModels`.

### 2.7 ui/ primitives (import from `../../ui`)

All forward unknown props (id, className, aria-*, data-*, handlers, ref) to the
root element unless noted. `bare` drops the module styles and keeps only the
classes you pass.

| component | props | DOM |
|---|---|---|
| `IconSprite` | — | `svg.icon-sprite` with all 50 legacy `<symbol id="i-*">` |
| `Icon` | `name: IconName`, `size?: "2xs"\|"xs"\|"sm"\|"md"\|"lg"\|"menu"` (md) | `svg.icon.icon--<size>[aria-hidden] > use[href=#i-name]` |
| `LEGACY_ICONS` | legacy `ICONS` presets: `<Icon {...LEGACY_ICONS.folder} />` | |
| `Button` | `variant?: "plain"\|"primary"\|"secondary"` | `button[type=button]` |
| `IconButton` | `icon?`, `iconSize?` (md) | `button.icon-button[type=button]` (legacy `.icon-button` styles) |
| `Popover` | `open`, `onClose(reason)`, `ignoreRefs?`, `dismissOn?: "pointerdown"\|"click"\|false`, `closeOnEscape?` (true), `returnFocusRef?` | `div[hidden]` |
| `useDismiss` | `{ enabled, insideRefs, onDismiss, event?, escape? }` | hook for custom overlays |
| `Menu`, `MenuItem`, `MenuDivider` | `MenuItem`: `icon?`, `trailing?`, `danger?` (adds `danger` class) | `div` / `button[type=button]` / `div` |
| `Modal` | `open`, `onClose?`, `id?` (overlay), `overlayClassName?`, `className?` (dialog), `labelledBy?`, `closeOnBackdrop?` (true), `closeOnEscape?` (false), `dialogProps?` | `div#id[hidden] > section[role=dialog][aria-modal=true]` |
| `ContextMenu` | `open`, `x`, `y`, `align?: "start"\|"end"`, `margin?` (8) | fixed `div[hidden]`, clamped to the viewport after measuring |
| `Toast` | `message`, `tone?` | `div[role=alert][data-tone][hidden]` |
| `SegmentedControl` (alias `Tabs`) | `items: {value,label,title?,attrs?}[]`, `value`, `onChange`, `itemClassName?`, `selection?: "aria-pressed"\|"class"`, `activeClassName?` | `div > button[type=button]*` |
| `SearchInput` | `icon?` (search, null = none), `iconSize?`, `wrapperClassName?`, `wrapperId?`; rest → `<input type=search>` | `div > svg? + input` |
| `EmptyState` | — | `div.empty-list` |
| `Spinner` | — | decorative pulsing dot |
| `Kbd` | `bare?` | `kbd` |
| `ResizeHandle` | `getSize`, `direction?: 1\|-1`, `onResize`, `onCommit`, `onReset?`, `onDraggingChange?`, `step?` (8), `largeStep?` (32), `min?`, `max?`, `value?` | `div[role=separator][aria-orientation=vertical][tabindex=0]`, `.dragging` while dragging |
| `MarkdownView` | `html`, `onCopyCode?(code)` | `div` with the HTML; delegates `.copy-code` clicks |
| `useMergedRef` | refs… | |

Escape handling: the shell owns the legacy central Escape chain (3631-3643), which
closes search, workspace browser, workspace popover, tag picker, session menu,
settings submenus, settings popover, file tree — first match only — and otherwise
interrupts the running turn. Overlays in that chain must not also close
themselves on Escape (`Modal` defaults `closeOnEscape={false}`; pass
`closeOnEscape={false}` to `Popover`). Overlays outside the chain keep their own
legacy Escape listeners: composer popovers (2384-2389), usage popover (3882-3885),
task panel (3810-3816), feedback modal (3395-3397).

---

## 3. app.js ownership (every line)

| lines | legacy item | owner | target |
|---|---|---|---|
| 1-53 | `state` object | foundation | `state/store.ts` `AppState`, `createInitialState` |
| 55-56 | `$`, `$$` | foundation | dropped (React refs / state) |
| 58-60 | `icon()` | foundation | `ui/Icon` |
| 62-73 | `ICONS` | foundation | `ui/Icon` `LEGACY_ICONS` |
| 75-84 | `TAG_COLORS` | sidebar | `features/sidebar/` (tag colours) |
| 86-490 | `I18N` | foundation | `i18n/messages.ts` |
| 492-513 | `TAG_COLOR_NAMES` | foundation | `i18n/messages.ts` (used by sidebar) |
| 515 | `systemTheme` | shell | `shell/actions.ts` (`resolvedTheme`, `watchSystemTheme`) |
| 517-522 | `t` | foundation | `i18n/index.ts` |
| 524-526 | `resolvedTheme` | shell | `shell/actions.ts` |
| 528-557 | `renderPreferenceControls` | shell (529-549: `#themeValue`, `#languageValue`, `.active` choices); composer (550-556: policy label + mode picker re-render) | shell `UserArea`; composer re-renders from store |
| 559-564 | `applyTheme` | shell | `shell/actions.ts` (implemented) |
| 566-601 | `applyLocale` | shell (566-581 lang/persist/i18n attrs); sidebar (582-585 `#addWorkspace` tooltip `${t("addWorkspace")} ⌥⌘O` / `Ctrl+Alt+O` + aria-label; 597 lists; 599-600 search re-render); files (586-589 `#previewClose` title `⇧⌘B` / `Ctrl+Shift+B`, tree/preview re-render); composer (590-596 unused `policyLabels`, preference controls); conversation (598 timeline) | i18n re-render is automatic; each owner renders its own translated attributes |
| 603-650 | `escapeHtml`, `contentText`, `renderMarkdown` | foundation | `lib/markdown.ts` |
| 652-669 | `compact`, `toolInputSummary` | foundation | `lib/format.ts` |
| 671-682 | `api` | foundation | `lib/api.ts` |
| 684-692 | `showAuthBanner` | foundation | `state/session.ts` (shell renders `#authBanner`) |
| 694-707 | `exchange` | foundation | `state/session.ts` |
| 709-717 | `basename` | foundation | `lib/format.ts` |
| 719-725 | `sessionTitle` | foundation | `state/session.ts` |
| 727-729 | `stateLabel` | sidebar | `t(status)` in session rows |
| 731-737 | `taskStatus` | foundation | `state/session.ts` |
| 739-747 | `relativeTime` | foundation | `lib/format.ts` + `i18n.formatRelativeTime` |
| 749-754 | `emptyList` | foundation | `ui/EmptyState` |
| 756-758 | `groupName` | sidebar | sidebar helper |
| 760-819 | `buildSessionRow` | sidebar | session row component |
| 821-912 | `renderSessionLists` | sidebar (822-904, 906-911); workspace (905 `renderWorkspaceOptions`) | project/recent/grouped lists |
| 914-927 | `switchConversationView` | sidebar | |
| 929-955 | `applyTagFilter` | sidebar | rows filtered by render, not `style.display` mutation (same visible result: hidden rows and groups get `display: none`) |
| 957-1012 | `renderGroupedView`, `buildGroupedSection` | sidebar | |
| 1014-1080 | `positionTagPicker`, `openTagPicker`, `showTagNameInput` | sidebar | `ui.tagPicker` + `ContextMenu align="end"` |
| 1082-1095 | `knownWorkspaces` | foundation | `state/session.ts` |
| 1097-1123 | `renderWorkspaceOptions` | workspace | `WorkspaceControl` (`#workspaceButtonName`, `#workspaceRecentList`) |
| 1125-1134 | `openWorkspacePopover`, `closeWorkspacePopover` | workspace | `ui.workspacePopoverOpen` |
| 1136-1138 | `closeWorkspaceBrowser` | workspace | `ui.workspaceBrowserOpen = false` |
| 1140-1162 | `renderWorkspaceDirectoryList` | workspace | `WorkspaceBrowserModal` |
| 1164-1185 | `loadWorkspaceDirectory`, `openWorkspaceBrowser` | workspace | `workspace/actions.ts` (implemented) |
| 1187-1280 | `searchableText`, `openSearch`, `closeSearch`, `renderSearchResults`, `moveSearchSelection`, `openSelectedSearchResult` | sidebar | `SearchModal`, `sidebar/actions.ts` |
| 1282-1285 | `toggleArchived` | sidebar | |
| 1287-1329 | `closeSessionMenu`, `openSessionMenu` (rename / archive / delete) | sidebar | `SessionMenu` with `ui.sessionMenu` + `ContextMenu` |
| 1331-1334 | `workspaceApi` | foundation | `lib/api.ts` |
| 1336-1342 | `ancestorPaths` | foundation | `lib/format.ts` |
| 1344-1440 | `loadTreeDirectory`, `openTree`, `refreshTree`, `toggleTreeDirectory`, `revealInTree` | files | `files/actions.ts` (implemented) |
| 1442-1521 | `treeRow`, `buildTreeRow`, `appendTreeLevel`, `treeNote`, `renderTree` | files | `FileTreePanel` (`#fileTreeBody`, `#fileTreeName` = basename(cwd) with `title` = cwd; placeholder text 工作区 before any tree) |
| 1523-1550 | `treeSearchTimer`, `treeSearchSequence`, `searchTree` | files | 160 ms debounce, sequence guard |
| 1552-1578 | `activateTreeRow`, `handleTreeKeydown` | files | |
| 1580-1589 | preview constants (`PREVIEW_WIDTH_KEY`, `PREVIEW_WRAP_KEY`, `PREVIEW_MIN` 320, `PREVIEW_DEFAULT` 560, `HIGHLIGHT_LIMIT`, `PREVIEW_LINE_LIMIT`) | files | |
| 1591-1709 | `KEYWORDS`, rules, `HIGHLIGHT_FAMILIES`, `LANGUAGE_FAMILIES`, `fileLanguage`, `highlightFamily`, `highlightLines` | files | `features/files/highlight.ts` |
| 1711-1715 | `formatBytes` | foundation | `lib/format.ts` |
| 1717-1758 | `setPreviewOpen`, `openFile`, `loadPreviewTab` | files | `files/actions.ts` (implemented) |
| 1760-1873 | `closePreviewTab`, `previewMessage`, `buildCodeView`, `renderPreview` | files | `PreviewPanel` (markdown via `ui/MarkdownView` + `copyText`) |
| 1875-1980 | `previewMaxWidth`, `applyPreviewWidth`, `initPreviewPanel` (resizer, tabs click/auxclick/keydown, close/show/wrap/mode/reload/copy) | files | `PreviewPanel`, `PreviewShowButton`; width in `ui.previewWidth` (initial: stored or 560, clamped), `ui.resizing` while dragging |
| 1982-2053 | `refreshWorkspaces`, `addWorkspace`, `chooseWorkspaceFolder`, `removeWorkspace` | workspace | `workspace/actions.ts` (implemented) |
| 2055-2096 | `timelineFromEntries` | foundation | `state/session.ts` |
| 2098-2105 | `copyText` | foundation | `state/session.ts` |
| 2107-2185 | `FEEDBACK_TOPICS`, `FEEDBACK_TOPIC_LABELS`, `openFeedback`, `closeFeedback`, `renderFeedbackTopics`, `submitFeedback` | conversation | `FeedbackModal` |
| 2187-2204 | `forkAtEntry` | conversation | |
| 2206-2244 | `wireMessageActions`, `wireCopyActions` | conversation (copy-code delegation in `ui/MarkdownView`) | |
| 2246-2281 | `renderTimeline` | conversation | `ConversationStream` (empty state, messages, tool rows, approvals, scroll to bottom; banner/usage derive from the store) |
| 2283-2313 | `messageActions`, `formatTokens` | conversation (`formatTokens` → `lib/format.ts`) | |
| 2315-2343 | `buildApproval` | conversation | approval card; verdict state is component-local |
| 2345-2352 | `mergeSessionSummary` | foundation | `state/session.ts` |
| 2354-2391 | `setupPopover` | composer | composer popovers (`ui/Popover` with `dismissOn="pointerdown"`, `returnFocusRef` = trigger; one open at a time) |
| 2393-2478 | `controlOption`, `hint`, `note` | composer | |
| 2480-2556 | `modelMeta`, `POLICY_ICONS`, `tOr`, `policyLabel`, `policyDescription`, `renderPolicies`, `policyPopover` | composer (`tOr` → `i18n`) | |
| 2558-2826 | `COMPACT_MODEL_COUNT`, `PINNED_MODELS_KEY`, `pinnedModels`, `togglePinnedModel`, `modelKey`, `groupLabel`, `renderModelPicker`, `EFFORT_LABELS`, `modelPopover` | composer (`modelKey` → `state/session.ts`) | |
| 2828-2917 | `MODES`, `renderModePicker`, `toggleMode`, `modePopover` | composer | |
| 2919-2985 | `MAX_ATTACHMENT_BYTES`, `readFileAsBase64`, `addAttachments`, `renderAttachments`, `#attachButton` / `#attachInput` wiring | composer | |
| 2987-2990 | `populateModels` | composer | dissolved (picker reads `state.current`) |
| 2992-3011 | `renderSnapshot` | foundation | `state/session.ts` |
| 3013-3109 | `connectStream` | foundation | `state/session.ts` |
| 3111-3182 | `refreshSessions`, `refreshCurrent`, `openSession`, `startDraft`, `createSessionIfNeeded` | foundation | `state/session.ts` |
| 3184-3193 | `showError` | foundation | `state/session.ts` (shell renders `#errorToast`) |
| 3195-3222 | `toggleUserMenu`, `closePreferenceSubmenus`, `togglePreferenceSubmenu` | shell | `toggleUserMenu` in `shell/actions.ts`; submenus via `ui.preferenceSubmenu` |
| 3224-3231 | login-report doc comment (function removed upstream) | shell | nothing to port (see section 6) |
| 3233-3243 | `logout` | shell | |
| 3245-3254 | `interruptCurrent` | foundation | `state/session.ts` |
| 3256-3273 | `readCssPx`, `TEXTAREA_MIN_H`, `TEXTAREA_MAX_H`, `resizePrompt` | composer | |
| 3275-3381 | sidebar width constants, `sidebarMaxWidth`, `clampSidebarWidth`, `currentSidebarWidth`, `applySidebarWidth`, `initSidebarResizer` (incl. window resize clamp) | sidebar | `SidebarResizer` with `ui/ResizeHandle`; width in `ui.sidebarWidth`; `ui.resizing` + body cursor while dragging |
| 3383-3388 | `#sidebarToggle`, `#sidebarShow` click → toggle `sidebar-hidden` | sidebar (3383-3385, `#sidebarToggle` is in `.brand-row`); shell (3386-3388) | `ui.sidebarHidden` |
| 3389 | `#authBannerReload` → `location.reload()` | shell | |
| 3390-3397 | feedback close / backdrop / submit / Escape | conversation | |
| 3398-3400 | `#newSession` → `startDraft(activeCwd())` | sidebar | |
| 3401-3425 | `#searchPlaceholder`, `#searchClose`, `#searchModal` backdrop, `#globalSearchInput` input + keydown (IME guard) | sidebar | |
| 3426 | `#archiveToggle` | sidebar | |
| 3427-3454 | `#userMenuButton`, `#themeMenuItem`, `#languageMenuItem`, `#logoutMenuItem`, `[data-theme-choice]`, `[data-language-choice]` | shell | |
| 3455-3460 | `[data-view]` tabs, `#tagFilterChip` | sidebar | |
| 3461-3494 | `#workspaceButton`, `#workspaceBrowseButton`, browser close/cancel/backdrop, `#workspaceDirectorySearch`, `#workspacePathGo`, `#workspacePathInput` (IME guard), `#workspaceParentButton`, `#workspaceBrowserConfirm` | workspace | |
| 3495 | `#addWorkspace` → `chooseWorkspaceFolder()` | sidebar | |
| 3496-3507 | `#fileTreeBack`, `#fileTreeSearch`, `#fileTreeRefresh`, `#fileTreeBody` click/keydown | files | |
| 3508 | `#stopRun` → `interruptCurrent` | composer | |
| 3509-3522 | `#policyMenu` `policychange` → PATCH policy | composer | |
| 3523-3549 | `#composer` submit | composer | |
| 3550-3574 | `enterGuard` | foundation | `lib/ime.ts` |
| 3576-3583 | `#prompt` IME guard, autoresize, Enter submits | composer | |
| 3585-3598 | document click: 3586-3587 session menu, 3588-3589 tag picker | sidebar | `useDismiss` with `event="click"` and the legacy exclusions |
| | 3590-3595 user popover (excl. `#userPopover,#userMenuButton,#themeSubmenu,#languageSubmenu`) | shell | |
| | 3596-3597 workspace popover (excl. `#workspacePopover,#workspaceButton`) | workspace | |
| 3599-3644 | document keydown: ⌥⌘O / Ctrl+Alt+O (`event.code === "KeyO"`) → `chooseWorkspaceFolder`; ⌥⌘P → `openTree({cwd: activeCwd()})`; ⌘B / ⇧⌘B; ⌘K → `openSearch`; Escape chain | shell | `ShellEffects` |
| 3646 | `?sb=0` | foundation | `createInitialState` (`ui.sidebarHidden`) |
| 3647-3649 | system theme listener | shell | `watchSystemTheme` (ShellEffects) |
| 3650-3652 | initial `applyTheme` / `applyLocale` / `renderPreferenceControls` | foundation | `main.tsx` |
| 3653-3656 | `initSidebarResizer()`, `initPreviewPanel()` at startup | sidebar, files | restore stored widths in a layout effect on mount |
| 3657-3660 | initial `updateTaskBanner()`, `updateUsageTrigger()` | conversation, composer | derived from the timeline |
| 3662-3816 | `bannerCountsFromTimeline`, `taskPanelRowsFromTimeline`, `panelStateOf`, `renderTaskPanel`, `toggleTaskPanel`, `updateTaskBanner`, `#bannerHead` click, Escape listener | conversation | `TaskBanner` |
| 3818-3885 | `sessionUsage`, `renderUsagePopover`, `updateUsageTrigger`, `toggleUsagePopover`, `#usageTrigger` click, capture-phase outside click (`#usageMenu`), Escape listener | composer | usage popover |
| 3886-3919 | bootstrap IIFE | foundation | `state/session.ts` `bootstrap` |

---

## 4. index.html ownership

| lines | region | owner |
|---|---|---|
| 1-9, 1289-1291 | document, `<html lang data-theme>`, head, script tag | foundation (`client/index.html`, `main.tsx`) |
| 10-536 | `svg.icon-sprite` (50 symbols) | foundation (`ui/IconSprite`) |
| 537 | `div.app` | foundation (App.tsx) |
| 538, 770 | `aside.sidebar` | foundation (App.tsx) |
| 539-555 | `.brand-row` (`.brand`, `.brand-mark`, `#sidebarToggle` title "收起侧边栏 ⌘B", aria-label "收起侧边栏") | sidebar |
| 557-576 | `nav.sidebar-actions` (`#newSession`, `#searchPlaceholder` with `<kbd>⌘K</kbd>`) | sidebar |
| 578-640 | `section.conversation-list` (view tabs, `#tagFilter`, `#projectView`, `#listHeading`, `#addWorkspace`, `#archiveToggle`, `#projectGroups`, `#recentGroup`, `#recentTasks`, `#groupedView`) | sidebar |
| 642-673 | `#fileTree` (`#fileTreeBack`, `#fileTreeName`, `#fileTreeRefresh`, `#fileTreeSearch` placeholder "搜索文件名", `#fileTreeBody[role=tree]`) | files |
| 675-769 | `.user-area` (`#userPopover`, `#stepPlanLink`, `#themeMenuItem`, `#themeSubmenu`, `#languageMenuItem`, `#languageSubmenu`, `.user-menu-divider`, `#logoutMenuItem`, `#userMenuButton`) | shell |
| 772-783 | `#sidebarResizer` | sidebar |
| 785, 1026 | `main.main` | foundation (App.tsx) |
| 786-796 | `#sidebarShow` | shell |
| 797-809 | `#previewShow` | files |
| 810-832 | `#taskBanner` | conversation |
| 833-844 | `#stream`, `#streamInner`, empty state | conversation |
| 846, 1008 | `div.composer-zone` | foundation (App.tsx) |
| 847-978 | `form#composer` + `.composer-card` (`#prompt`, `#attachmentList`, `#attachButton`, `#attachInput`, `#policyMenu`, `#modeMenu`, `#usageMenu`, `#modelMenu`, `#stopRun` "停止", `#sendButton`) | composer |
| 979-1006 | `#workspaceControl` (`#workspaceButton`, `#workspaceButtonName` neutral placeholder "Workspace" until a cwd exists, `#workspacePopover`, `#workspaceRecentList`, `#workspaceBrowseButton`) | workspace |
| 1007 | `</form>` | composer |
| 1010 | `#sessionMenu` | sidebar |
| 1011 | `#errorToast` | shell (implemented by Foundation in the placeholder) |
| 1012-1025 | `#authBanner` (+ `#authBannerReload`) | shell |
| 1028-1113 | `aside#previewPanel` (`#previewResizer`, `#previewTabs`, `#previewClose`, `#previewPath`, `#previewMode`, `#previewWrap`, `#previewReload`, `#previewCopy`, `#previewBody`) | files |
| 1114 | `</div>` (.app) | foundation |
| 1115 | `#tagPicker` | sidebar |
| 1116-1157 | `#feedbackModal` | conversation |
| 1159-1202 | `#searchModal` | sidebar |
| 1203-1279 | `#workspaceBrowserModal` | workspace |
| 1280-1288 | `#loggedOutOverlay` | shell |

---

## 5. styles.css ownership

Port each range verbatim into the target file. Foundation ranges are already in
`styles/global.css` or the ui modules.

| lines | rules | owner | target |
|---|---|---|---|
| 1-116 | `:root` tokens, dark theme | foundation | `styles/global.css` |
| 117-155 | reset, focus ring, scrollbars, `.icon*`, `.icon-sprite` | foundation | `styles/global.css`, `ui/IconSprite` |
| 157-166 | `.app`, `.app.sidebar-hidden`, `@keyframes pulse` | foundation | `styles/global.css` |
| 168-178 | `.icon-button` | foundation | `ui/IconButton/IconButton.module.css` |
| 179-189 | `.sidebar-show`, `.app.sidebar-hidden .sidebar-show` | shell | `features/shell/*.css` |
| 191-203 | `.sidebar` | foundation | `styles/global.css` |
| 205-235 | `.sidebar-resizer*`, `.app.sidebar-hidden .sidebar-resizer` | sidebar | `features/sidebar/*.css` |
| 236-237 | `.app.resizing` | foundation | `styles/global.css` |
| 238 | `.app.resizing .sidebar-resizer::after` | sidebar | |
| 239-247 | `.brand-row`, `.brand` | sidebar | |
| 248-257 | `.brand-mark` | foundation | `styles/global.css` (shared with the logged-out overlay) |
| 259-437 | sidebar actions, view tabs, tag filter, list heading, project groups, session rows, tags, badges | sidebar | |
| 438 | `.empty-list` | foundation | `ui/EmptyState` |
| 439-464 | grouped view | sidebar | |
| 466-513 | file tree | files | |
| 515-600 | preview panel, code view, `.tok-*` | files | |
| 602-673 | user area, settings popover, submenus | shell | |
| 675-684 | `.main` | foundation | `styles/global.css` |
| 685-704 | `.stream`, `.stream-inner`, `.empty-state`, `.empty-wordmark`, `.message`, `.message-label` | conversation | |
| 705 | `.message-body` | foundation | `styles/global.css` (shared with `.preview-markdown`) |
| 706-707 | `.message.user/.assistant .message-body` | conversation | |
| 708 | `.message-body code:not(.code-block code)` | foundation | `styles/global.css` |
| 709-720 | `.message-actions`, `.message-action` (first block) | conversation | |
| 721-726 | `.code-block*`, `.copy-code` | foundation | `styles/global.css` |
| 728-753 | `.tool-row`, `.approval*` | conversation | |
| 755-782 | `.composer-zone`, `.composer`, `.composer-card`, textarea, `.composer-controls`, `.composer-right` | composer | |
| 783-911 | `.control-select`, `.control-menu`, `.control-popover*`, `.control-option*`, `.control-segment*` | composer | |
| 912 | `.chevron` | foundation | `styles/global.css` |
| 913-972 | feedback dialog | conversation | |
| 973-988 | message action row (second block) | conversation | |
| 989-1020 | attachments, `.send-button`, `.stop-button` | composer | |
| 1021-1071 | `.workspace-control`, `.workspace-popover*`, `.workspace-recent-item`, `.workspace-browse-button` | workspace | |
| 1073-1144 | workspace browser dialog, `.primary-action`, `.secondary-action` | workspace (`ui/Button` mirrors 1142-1144) | |
| 1146-1263 | search overlay and dialog | sidebar | |
| 1265-1277 | `.context-menu` | sidebar (`ui/ContextMenu` mirrors 1265-1274) | |
| 1278-1296 | `.error-toast` | shell (`ui/Toast` mirrors it) | |
| 1297-1331 | `.auth-banner` | shell | |
| 1332-1356 | `[data-tooltip]` tooltips on `.project-action` / `.list-action` | sidebar | |
| 1357-1388 | `.tag-picker`, `.tag-create` | sidebar | |
| 1389-1398 | `.logged-out-overlay` (first block) | shell | |
| 1399-1410 | `.user-popover-login`, `.settings-login` | shell | |
| 1411-1415 | `.logged-out-overlay` (second block) | shell | |
| 1417-1419 | narrow-viewport tokens | foundation | `styles/global.css` |
| 1420-1424 | narrow-viewport preview | files | |
| 1426-1428 | reduced motion | foundation | `styles/global.css` |
| 1429 | `.control-segment-none` | composer | |
| 1430-1460 | task banner and task panel | conversation | |
| 1461-1481 | usage popover | composer | |

Desktop-only rules (`[data-host="desktop"]`, macOS title-bar inset and drag
regions) are new and live at the end of `styles/global.css`.

---

## 6. Known discrepancies to resolve in Integration

- `test/e2e/web.e2e.mjs` ("the settings popover reports the borrowed credential")
  still reads `#loginNote`, `#loginCommand` and an undefined `shown.summary`. The
  login section was removed from the legacy UI in commit cdf3bb3 ("删除底部无用文案"),
  so the legacy client already fails that assertion. Do not restore the section
  without the user's say-so; update the test instead.
- `scripts/check-browser-smoke.mjs` reads `apps/web/public/*`. After the legacy
  files are removed it must check `client/index.html`, `client/src/**` and
  `client/src/styles/global.css` (tokens and the grid string are kept verbatim
  there).
- Root `biome.json` does not include `apps/web/client/**` or `*.tsx` yet.
