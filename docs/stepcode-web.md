# StepCode Web Host

StepCode Web is a loopback-only Node Host plus a browser projection.

- `AgentSessionRuntime` owns the agent lifecycle.
- `AgentSession` owns the active session and event stream.
- `StepSessionManager` wraps Pi's current JSONL v3 `SessionManager`.
- `packages/agent-core`'s JSONL v4 `JsonlSessionRepo` is not used by Step CLI or
  this Web Host.

The Web Host does not parse, repair, migrate, or write session JSONL directly.
It projects session snapshots and agent events over HTTP/SSE and sends user
actions back through the runtime. The browser never receives credentials.

Authentication is a one-time launch token exchanged for a signed, HttpOnly,
SameSite cookie. API requests require the cookie and a local Origin. The
server binds to `127.0.0.1` by default. Logging out expires the browser cookie;
re-entry requires a fresh terminal launch link.

The credential lives in `~/.stepcode/auth.json` (`STEPCODE_AUTH_PATH` overrides
it). It is written by `step login` in a terminal or by the sign-in dialog of
Web and Desktop (see "Sign-in dialog" below), in the same shape, so CLI, Web and
Desktop share one sign-in, and the Host reuses that credential exactly as the
CLI does:

- It calls `syncStepLoginProfileEndpoint` before building the ModelRuntime, so the
  credential is sent to the region its stored profile names. The CLI does the
  same before every session; without it a `step_plan` credential goes to the
  default endpoint and discovery fails.
- It reads the persisted `defaultProvider` / `defaultModel` from `config.toml`
  (`readGlobalStepDefaults`) and passes them as the session defaults, which is
  what the CLI injects into argv through `withStepDefaults`. The result is that
  the Web UI lists the same models and starts on the same model as the CLI.
- It refreshes the model catalog *before* a session resolves its model. The Step
  catalog is discovered over the network and ships no built-in baseline, so an
  unrefreshed runtime offers zero models and the session would be left on
  agent-core's `unknown` placeholder, where sending fails with "No API key found
  for the selected model" — an error that names no provider.
- If resolution still yields no model, the session adopts the first model the
  runtime lists rather than staying on the placeholder.

`GET /api/v1/login` (and the `login` field of `/api/v1/bootstrap`) reports where
the credential comes from: `environment` or `auth.json`, with the provider,
login profile, validity, and the `step login` command that changes it. The
credential itself is never part of the response, and the settings dialog shows
this section read-only — there is no key field, because a field here could not
sign anything in.

Presence and reachability are reported separately: `getStepLoginStatus` treats an
unreachable provider as "not logged in", but the credential is still on disk and
the next request may succeed, so `configured` reflects the stored credential and
`validity` reports what the provider said (`valid`, `invalid`, `unavailable`).

### Sign-in dialog

When the bootstrap report says `configured: false` (no `auth.json`, an empty
one, or no `step` entry, and no `STEP_API_KEY`), bootstrap stops before it opens
any session and shows `#loginGate`, a dialog with no close control; Escape and
global shortcuts are ignored while it is open. Web and Desktop both show it.

A session fixes its model catalog and provider endpoint when it is built, so
one opened before the credential existed (another tab, or a page loaded before
the dialog) would stay on the `unknown` model and fail with "No API key found
for the selected model". After a credential is saved the Host therefore releases
every idle open session (`WebSessionStore.reloadCredentials`): its SSE streams
end, the page's EventSource reconnects, and the next request rebuilds it from
its file with the new credential. A session without a file yet (no message
sent) is recreated under the same id. Sessions in a running turn are left
alone.

The dialog offers the four `step login` profiles, split by region
(`GET /api/v1/login/methods`):

| Region | Step Plan (browser) | API key |
| --- | --- | --- |
| China (default) | `step_plan` | `platform_cn`, key page `platform.stepfun.com/interface-key` |
| International | `step_plan_oversea` | `platform_oversea`, key page `platform.stepfun.ai/interface-key` |

- **Step Plan**: `POST /api/v1/login/browser` runs the kernel's
  `loginStepInBrowser`, the same cloud flow as `step login`, and answers with the
  authorize URL, which the client opens in the system browser. The client polls
  `GET /api/v1/login/browser` until `completed` or `failed`; Cancel sends
  `DELETE`, which aborts the wait so a later approval writes nothing.
- **API key**: `POST /api/v1/login/api-key` runs `loginStepWithApiKey`, which
  calls `GET <profile base>/v1/models` with the key and saves it only on 2xx. A
  401/403 is reported as `invalid_key`; any other failure as `unavailable`, and
  nothing is saved.

Without a stored choice, Desktop starts in the system language
(`navigator.language`: `zh*` is Chinese, anything else English); the browser
keeps its zh-CN default.

The approval path is an adapter: Step extensions call
`ExtensionUIContext.confirm`, the Web Host's approval broker emits an SSE
request, and the browser returns `approve`, `approve_for_session`, or `deny`.
Missing or cancelled approvals fail closed.

Approval snapshots and SSE requests include the full captured tool `input` and
the specific policy `reason`. The browser renders a neutral card with a localized
approval title and the complete command or file-change preview, instead of the
clipped Call/batch diagnostic message. Content initially shows three lines and
can expand; the full arguments remain available before a verdict. The card offers
only Deny and Allow for Session. Allow for Session is keyed by the canonical tool
name, so later calls with different call IDs reuse the grant; other tools still
ask. Specific danger or incomplete-analysis prompts still require a verdict per
call, even with a session grant. These presentation changes do not alter the permission policy or the
existing verdict endpoint.

Kernel selectors (`ExtensionUIContext.select`) go through the same kind of
adapter. The Web Host's selection broker emits `selection_required` with the
kernel's title and option labels, lists pending selections in snapshots as
`pendingSelections`, and `POST /api/v1/sessions/{id}/selections/response`
returns the chosen label verbatim (or nothing, for a dismissed dialog). The
kernel parses the answer; the host never picks an option itself. This carries
the Full Access risk acknowledgment: `PATCH .../policy` with `full-access` runs
`/permissions full-access`, returns with the question pending and the tier
unchanged, and the tier changes only after the user grants it. Cancel, Escape
or the close button keeps the previous tier. A session whose settings already
name Full Access without a remembered acknowledgment asks at start and runs as
Approve for Me until answered. A draft (no session yet) asks the same question
in the browser and hands the answer to the new session's kernel on the first
send. The snapshot's `permissionPreset` is the tier the kernel enforces now,
reported by the Step extension's `onPermissionChange` hook, because a "this
session" grant is not persisted.

Clarification uses the existing `clarify_user` tool and the optional structured
`ExtensionUIContext.clarify(questions, signal)` capability. The coding tool owns
normalization and tool-result text; the Web Host transports the complete question
set through `clarification_required` SSE and `pendingClarifications` in snapshots.
The extension runner brackets this capability with the existing `custom`
`ui_prompt_start` / `ui_prompt_end` lifecycle, so runtime consumers see the same
user-wait interval as a terminal dialog.
`POST /api/v1/sessions/{id}/clarifications/response` validates question order and
option indexes, derives canonical option values, and resumes the pending tool
call. It never sends the answer as a new user prompt. `clarification_resolved`
removes the card on every connected page. Abort, session replacement and shutdown
cancel pending calls. Browser reload restores pending questions while the Host is
alive; restarting the Host does not replay interrupted tools.

The composer shows a paginated question card above its input. Clicking a choice
or skipping saves that answer and advances. The last outstanding answer submits
the complete set automatically. Custom replies use Enter (Shift+Enter inserts a
newline; IME confirmation does not submit). Paging preserves selections and text
drafts. Navigating ahead never implicitly answers an earlier question. The close
button cancels the set; failed sends retain answers for retry. Voice input is not
part of this flow. The shared React client renders the same card in desktop hosts.
`clarify_user` is classified as a non-mutating tool, so Ask opens the questions
directly; explicit per-tool confirm/deny overrides still apply. Escape cancels
the waiting turn through the existing interrupt action.

Within one Web Host process, an in-memory per-session writer lease prevents two
Web session objects from appending to the same JSONL file. This is not a
cross-process lock. An older CLI that does not participate in a lease protocol
must be closed before the Web Host opens the same session.

Workspaces are folders the user registered through "Add workspace" (sidebar
button, or Alt+Cmd+O / Ctrl+Alt+O). The Host opens the operating system's
folder chooser when that dialog would appear on the machine in front of the
user: a loopback bind, no SSH session, and a desktop (on Linux also a display
and zenity or kdialog). A browser cannot do this itself — its directory pickers
return file contents, never a path — so the page asks the Host
(`POST /api/v1/workspaces/pick`) and the request stays pending while the dialog
is open. `?` reports the mode so the page knows which to offer. The helpers are
`osascript` on macOS, `powershell.exe` on Windows (PowerShell compiles a small
C# wrapper around the Vista `IFileOpenDialog` in folder mode, so no extra
dependency is needed and non-ASCII paths survive the pipe), and zenity with a
kdialog fallback on Linux. One dialog at a time; a second request is refused
with 409. When the mode is `browse`, or when the helper fails, the page falls
back to the in-folder browser, so the button is never dead.
`STEPCODE_WEB_DIRECTORY_PICKER=native|browse` overrides the detection. The registry is Web Host metadata in
`web-workspaces.json` beside the session metadata. Its `workspaces` array lists
registered folders; `removedWorkspaces` records explicitly removed folders,
including folders inferred from existing sessions. `GET /api/v1/workspaces`
returns removed folders with `hidden: true` so session refreshes and page reloads
cannot recreate their project group. Hidden folders are excluded from recent
folder choices; their conversations remain readable under Recent and searchable.
Adding the folder again clears its removal marker and restores its project group.

Every project header offers removal, with or without conversations. An in-app
dialog names the project and explains that files and existing chats are retained.
Cancel has initial focus; Cancel, close, backdrop and Escape dismiss without a
request. Confirmation disables the controls while deletion of the navigation
entry is pending. Failures leave the dialog available for retry; the endpoint is
idempotent so a failed refresh after a successful removal can be retried. Removal
does not close or interrupt the active conversation, modify its history, or
change access to the cwd of an existing session.

File browsing is keyed by folder, not by session, so an empty workspace can be
browsed. `GET /api/v1/workspace/{files,file,raw,search}` take a `cwd` and answer
403 unless it is the launch folder, a registered workspace, or the cwd of an
existing session. Inside a workspace every path is resolved with `realpath` and
refused (400) when it lands outside the root, which also covers symlinks that
point out of the workspace.

- `files` lists one directory level (directories first, at most 1000 entries,
  `truncated` when cut). The tree is lazy: the browser asks for a level only
  when its folder is expanded, and remembers which folders were open.
- `search` is a bounded breadth-first name search. It runs on the Host because
  the browser only holds the levels already opened. It does not descend into
  `.git`, `node_modules`, or symlinked directories.
- `file` classifies a file as `text` (up to 1 MB, returned as UTF-8), `image`,
  `binary` (NUL byte in the first 8 KB), or `too-large`; only `text` carries
  content. `raw` streams images, and nothing else, for the preview.

Clicking a file opens a preview panel on the right: one tab per file, line
numbers, wrap toggle, reload, copy, a rendered view for Markdown, and inline
images. Highlighting is a small regex tokenizer per language family (comments,
strings, numbers, a shared keyword list), not a grammar per language; files over
300 KB are shown uncoloured and only the first 10 000 lines are rendered. The
panel is closed by default and takes its width from the main column, so the
shell remains two-column when nothing is being previewed. Shift+Cmd+B toggles
it; Alt+Cmd+P opens the tree for the current workspace.

Two readouts are derived from the session timeline rather than stored: the task
banner at the top right of the main column (task and subagent progress, from the
`task_*` and `subagent` tool calls) and the token indicator left of the model
picker (input/output totals, summed from the usage each assistant turn reports).
Both stay out of the way when there is nothing to report — the banner hides until
the session has run a task or a subagent, and the token control hides until a
turn reports usage — so neither shows a placeholder figure.

Each finished turn (one user message up to the next, including a message with
images only) that changed files gets a card under its last row: "Edited N
files", the summed `+added -removed` lines, and the files (three, then "show N
more"). The data is the unified patch in the tool result `details.patch`, which
both `edit` and `write` record themselves inside the file mutation queue, so it
is persisted with the session entry and survives a reload. A `write` patch is
taken after approval and after earlier calls of the same batch, and the result
also records `created` and the overwritten file's line ending and BOM
(`previous`). A write over 1 MB or of a binary file gets no patch
(`details.untracked` says why); the card marks such files as not revertable,
and a turn that ran `bash` says that what those commands changed is neither
listed nor reverted. Clicking a file opens the preview panel in its changes view
(turn picker, one row per file, inline diff with line numbers).
"Undo" calls `POST /api/v1/sessions/{id}/turns/{turnId}/revert`. Each card undoes
only its own turn: the turn's patches are reverse-applied newest first, and
nothing is written unless all of them apply. Like `patch -R`, a hunk may have
moved (later turns added lines elsewhere in the file) and its unchanged context
lines may have been edited since; only the lines the turn itself changed must be
intact. Otherwise the request is refused with 409 and a `code` (`conflict` with
the file's path, `missing`, `busy` while a turn runs or another revert of the
session is in progress, `reverted`), and the card tells the user to undo the
later turns that touched the file first; a prompt sent during a revert also gets
409. Undoing turns newest-first therefore always works. Files the turn created
are deleted, and an overwritten file gets its previous line ending and BOM back.
Files without a patch are left alone and listed in the response's `skipped`,
which the toast names.
A successful undo appends a `stepcode-web.turn-revert` custom message (in the
model's context, not a new turn) naming the request and the restored files, so
the model does not assume its edits are still on disk; the snapshot's
`revertedTurns` is derived from these entries, so the state follows the branch
and survives a host restart.

The composer's slash menu opens when the whole prompt is a single `/word`. It
lists two groups, fuzzy-matched with the CLI's scoring (a client copy of
`packages/tui/src/fuzzy.ts`): commands (`/goal`, `/init`, `/plan`, `/mcp`) and
the session's skills; a `skill:` prefix lists skills only. Arrow keys move
through both groups, Enter or Tab picks, Escape closes. Picking a command
inserts `/<name> ` so arguments can follow; the kernel runs it on send.
Skills come from `GET /api/v1/sessions/{id}/skills`
(the session's resource loader, so plugin skills are included); a draft uses
`GET /api/v1/workspace/skills`, which resolves the folder's skill resources
without extensions. Picking a skill inserts `/skill:<name> `; the kernel
expands it into the skill's instructions when the prompt is sent, and the
conversation shows the skill as a chip above the request. Picking `/mcp` shows
`GET /api/v1/mcp` in place: every server with its state, tool count and start
error, including servers disabled in `config.toml`. The kernel's own `/mcp`
command only prints through `notify`, which the Web host does not render. The
MCP status list is process-wide (written by the session that started last).

Session archive flags are Web Host metadata in `web-sessions.json`; canonical
conversation history remains the StepCode v3 JSONL file. Deleting a session
closes the runtime, removes the metadata entry, and removes that session's
canonical JSONL file.

Run from the repository root:

```bash
pnpm run web
pnpm run web:build
pnpm run web:serve
```

`pnpm --filter @step-harness/web test:e2e` runs the browser suite: it starts the
Host on a free port with a temporary agent directory and drives headless Chrome
over the DevTools protocol (set `CHROME_PATH` if Chrome is not in a default
location; the suite is skipped when none is found). It needs no model
credentials. The system folder chooser cannot be clicked by a test, so the
suite puts a stand-in with the real helper's name first on the server's PATH
and answers from a file; the real spawn, argv and parsing are still covered.

The production build emits `apps/web/dist/server.js`, the browser assets, and
`apps/web/dist/openapi.yaml`.

The browser UI follows PRD v2.0 revision 281 §3 and uses Kimi Code Web as its
information-architecture baseline: a light two-column shell, cwd-grouped
conversations in the sidebar, a conversation stream, and a centered composer
control group. There is no main-area header, fixed right rail, or Goal HUD.

The first release connects sessions, message/tool streaming, approvals, status,
cwd file browsing, the three CLI permission presets, model selection, known-workspace
selection, interrupt, archive/restore, rename, and deletion. The project module
retains the original MVP's project/group views, in-memory categories, category
filter, file tree, and in-place new conversation. Workspace selection is
available only when composing a new conversation; adding a workspace is always
available from the sidebar.

The avatar opens a Kimi-style account menu with Step Plan upgrade navigation,
light/dark/system appearance, zh-CN/en-US language, a local settings dialog,
and logout. Appearance and language persist in browser local storage. Search is
a first-release modal that filters session titles, message text, and workspace
paths with keyboard navigation.
Sessions whose stored working directory no longer exists stay readable under
Recent instead of being exposed as a file-browsable project.

Workspace selection appears only while composing a new conversation. It first
offers recent folders and then an in-app folder browser. Existing conversations
do not show a workspace switcher.

Attachments, agent-mode selection, and cron management UI remain outside the
10/15 first release. Cron capabilities remain available through conversation
tools.
