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

The token indicator left of the model picker derives input/output totals from
the usage each assistant turn reports and hides until a turn reports usage.
Task summaries live in the DFSC-style floating Summary board instead of the original
floating banner. Task completion comes from canonical task state, not completed
`task_create` / `task_update` calls.

Settled turns also expose a compact Outputs strip for supported document,
image, website, spreadsheet, presentation, audio and video references.
It combines explicit local Markdown links with successful structured
write/edit paths. Code-styled basenames qualify only when they identify an
unambiguous observed output; fenced examples, failed tools, reads and shell
prose do not prove delivery. The strip initially shows three entries and can
expand. These are references or observed writes, not proof that files still
exist; opening a missing file shows the existing preview error.

Assistant local links and delivery buttons open the same workspace-bound
Files inspector. Repeating a delivery button closes its selected preview
while preserving tabs and trigger focus; selecting another file switches the
preview. Markdown opens rendered, and links inside it resolve relative to the
document. Windows paths, encoded file URLs and line suffixes normalize before
the existing file API is called. Paths outside the workspace are rejected;
the Host remains responsible for realpath and symlink checks. There are no
automatic historical content reads, native-app actions, or new Office/PDF
renderers. HTML delivery recognition alone does not enable live HTML preview.

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

The browser UI retains its cwd-grouped conversations and centered composer.
The local DFSC presentation migration adds a right tool rail and a mutually
exclusive inspector area; it does not add a main-area header or Goal HUD.

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

## Subagent presentation

The Web client uses the DFSC Standard task rows: a persistent Bot icon, a
separate status icon, an agent label, task summary and trailing disclosure.
Structured `details.results` own the six task states; missing legacy statuses
remain unknown. Planned single, parallel and chain calls show queued tasks,
not fabricated running tasks. A rejected dispatch stays an ordinary failed
tool with its original input/output; per-task errors remain inspectable.

Selecting a task opens the existing read-only child transcript API in the
shared right inspector. Narrow screens use an overlay; expand, close and the existing Escape chain
retain the parent session. The inspector follows the selected tool/task index
as results arrive, shows model/turn metadata when recorded, and has no prompt,
execution or permission controls. Pending child records poll sequentially
without overlapping requests; late replies cannot replace another selection.

Background dispatch results are snapshots, not completion records.
Custom `agent-notification` entries expose only a validated
`details: { agentId, event, status }` projection. Known event/status pairs
update registered lanes without parsing message text. Settled chain steps
are preserved; a lane's terminal state cannot prove that a queued step ran.
This does not change orchestration, permissions, JSONL persistence or model
context. A host restart is needed for the added notification projection;
client-only task rows and inspector changes need only a page refresh.

## Right inspector

The rail exposes Summary, Context, Terminal, Changes, File preview, Subagents and Browser.
Terminal is immediately below Context, independently of the DFSC ordering.
Summary replaces the original floating task/subagent banner, rather than
coexisting with it. Summary is an independent content-height surface, not the
full-height inspector used by other rail entries. The compact board is 320px
wide with a 20px top inset, a 12px rail-side gap and a close-only header.
It scrolls internally only when its content exceeds the viewport. With at least
1120px of workspace width after the sidebar and tool rail, the layout reserves
reading space as necessary; otherwise the board overlays without narrowing the
conversation. It shows plan tasks with completion counts and completed-task
folding, a task progress track, agent records below the tasks, MCP and Skills.
The header retains the Summary title and close control, with compact task
completion and agent-record counts. Its activity dot pulses only for explicit
in-progress tasks or running agent records. Missing task data or unknown agent
statuses show an unknown indicator rather than implying completion; otherwise
the indicator is idle. It does not represent the parent model's streaming state.
The task track uses canonical completed/total tasks, never completed tool calls
or agent counts. Width changes use a 300ms cubic ease-out and become immediate
under reduced-motion; empty plans have no invented percentage.
A current-task headline and collapsed capsule are excluded.
Conversation navigation is intentionally excluded.

Agent records reuse validated timeline subagent states, including queued,
running, completed, failed, stopped, skipped and unknown. Counts refer to task
or dispatch records, not distinct runtime agents. Structured per-task records
take precedence over legacy child links to avoid double-counting one dispatch.
Missing legacy status stays unknown regardless of parent tool outcome.
Selecting a record opens the existing read-only task, child or workflow
inspector while retaining the parent conversation. No execution controls or
new session authority are introduced; background updates use the same
structured projection as the transcript.

Task or subagent activity in the latest user turn automatically opens Summary
when no inspector is active, including when restoring that turn from history.
The trigger is consumed once per selected session/turn: same-turn updates do
not undo manual dismissal, and activity never displaces another inspector.
Tool outcomes only trigger presentation; they do not determine task completion.

Summary uses DFSC's local light/dark neutral palette, rose running tint, green
completion and amber MCP failure status. Task and MCP disclosures animate their
height; task chevrons appear on hover, focus or expansion. A live task completion
contracts and regrows its fixed icon slot over 660ms, then draws the check mark;
the row stays visible for 1100ms before folding. Initial completed history does
not replay this transition. Reduced-motion disables spinner, disclosure and
status animations. MCP switch-shaped indicators are decorative and read-only.
These tokens and effects are scoped to Summary, not the transcript or app theme.

Files retain multiple tabs, image/Markdown previews, copy, wrap and refresh. Tool-triggered file, turn-change
and child-agent opens select the same right panel rather than competing overlays.
Closing a panel retains its selection; switching panels restores the standard
layout. Non-Summary inspectors retain draggable persisted widths,
standard/wide presets and an expanded view. Screens at 1200px or below start
closed and use an overlay for these inspectors.
Escape restores an expanded view first, then closes the panel without
interrupting the parent turn. Existing higher-priority dialogs still dismiss first.

`GET /api/v1/sessions/{id}/inspector` provides whitelisted active-plan task fields,
the session's available skill count, process-scoped MCP names/statuses and the
kernel's session statistics. Tasks come from the latest canonical `step-tasks`
snapshot on the active branch; a successful task tool is not evidence that a task
completed. Statistics use `AgentSession.getSessionStats()` without reassembling
model context. Totals include compacted history. Context usage is the kernel's
estimate; recorded-message inspection is not a claim to show the assembled request.
Provider transport fields, image payloads and opaque thinking signatures are
excluded from the recorded JSON view. Missing statistics display unknown values.
Polling is sequential, aborted on selection changes, and stale replies cannot
replace the new session's panel.

Per-turn tool changes remain accessible in the transcript and Changes inspector,
not as a substitute for Summary's repository overview. Repository comparison
remains pending. Interactive terminals use the separate adapter below. No Desktop runtime
or package is changed.

## Embedded browser

The Browser inspector uses a host-owned Chromium process controlled through
`playwright-core`. This is streamed webpage rendering and input forwarding,
not DFSC's native Electron WebContentsView. The dependency includes no browser
binary. Install compatible Chrome, Edge or Chromium, or set
`STEPCODE_WEB_BROWSER_PATH` to its executable. Detection covers common Windows,
macOS and Linux locations; only Windows Chrome has been exercised locally.
The engine starts on the first explicit tab creation, not on inspector open.

Tabs and cookies belong to an isolated, temporary browser context, never a
personal browser profile. They survive inspector hiding and Web page reloads
while the Host lives. Closing a tab destroys that page. Normal Host shutdown
closes its owned browser; restarting the Host starts with no browser tabs or
site cookies. This does not terminate unrelated browsers or external servers.
Crash recovery and durable site-profile persistence are not implemented.

`/api/v1/browser/*` uses the existing HttpOnly cookie and Origin checks. One
page at a time owns a 15-second input lease; polling every five seconds renews
it. The page's sessionStorage client id allows refresh to rotate the token,
and a late old-page release cannot remove its replacement. A competing page
gets 409 rather than silently moving another page's tabs or viewport. Closing
or hiding the inspector releases input/stream ownership, not tabs. A lost
connection exposes Reconnect; its lease expires if the page cannot release it.

HTTP(S) navigation, back/forward, reload/stop, twelve tabs, popup tabs and
50-200% reflow zoom are connected. Navigation errors remain visible on the tab.
Tab selection changes the remote frame source. The surface resizes with the
inspector, including its expanded view. Chromium renders the site, so
X-Frame-Options and site CSP are not removed or bypassed. Permissions are denied,
service workers blocked, and StepCode Host/client ports blocked across HTTP(S)
and WebSocket requests, including subresources and hostname aliases. No raw
debugging endpoint or arbitrary evaluation route is exposed.

Frames are JPEG over authenticated SSE. The host ACKs Chromium frames locally,
caps delivery at 15 fps and keeps at most one newest scheduled frame. A blocked
response drops frames and keeps only the newest metadata; the client keeps
one decoding image plus one pending latest frame. Input is serialized and
bounded (48 client / 64 host operations); pointer moves are coalesced. Hidden
inspectors disconnect the stream instead of decoding background frames.

Mouse clicks/dragging, wheel, editing/navigation keys, text paste and committed
Chinese composition text are forwarded. Copy selection reads selected text in
the main document or focused non-password input and writes it to the outer
browser clipboard only on an explicit action. Cross-origin iframe selection,
rich clipboard, native context menus, file upload/download, audio transport,
web permissions and a remote accessibility tree are not implemented. File
chooser attempts and downloads are cancelled with visible notices; JS dialogs
are dismissed with a notice. Video may appear as sampled frames, not smooth
media playback. Automated Chinese composition commits are covered; physical
IME candidate-window ergonomics still need manual acceptance.

The inspector's external-open control is an explicit separate action, not the
browser implementation. Browser storage and navigation have no connection to
Agent model context, tool execution or the user's provider credentials.

## Interactive terminals

The Terminal inspector uses `@xterm/xterm` with `@xterm/addon-fit`; the Host
owns isolated Node helper processes using `node-pty`. This is a real interactive
shell, not a model tool log or a pipe-based command runner. Creating a terminal
is explicit. Windows chooses installed PowerShell 7 or Windows PowerShell;
macOS/Linux choose an available bash, zsh or sh. User startup profiles and
inherited startup-injection variables are suppressed. The environment keeps
an OS-variable allowlist, not the Host's API keys or Node loader configuration.
This is not a sandbox: entered commands run with the Host user's filesystem
and network privileges and can read credentials available to that OS user.

`/api/v1/terminals/*` is behind the existing HttpOnly cookie and Origin checks.
Creation accepts a known workspace and bounded dimensions, not a caller-chosen
executable or startup command. There are at most eight tabs per workspace and
24 per Host, including exited/failed tabs. Tabs belong to workspaces, not Agent
sessions. Changing conversation within the same workspace retains the tabs.
Multiple authenticated pages may view/control the same shell; dimensions and
input are shared. There is no per-page terminal ownership lease.

Closing/hiding the inspector disconnects its output stream, not the shell.
Switching terminal tabs does the same. Refresh lists existing terminals and
replays retained output without creating a second process. Closing a terminal
tab terminates its owned process tree before removing it. Normal Host shutdown
attempts cleanup of all owned terminals and reports failures with a nonzero
exit status; unrelated externally launched services are untouched. Host restart
does not restore terminals. Crash recovery and processes deliberately detached
from terminal ownership are not guaranteed to be cleaned up.

SSE snapshots carry sequenced output and lifecycle metadata. The Host retains
at most 512 KiB / 2048 chunks per terminal; a replay gap produces a visible
truncation notice. Replaying a truncated ANSI tail is not a full terminal-screen
snapshot and may produce an incomplete screen layout. No output/history files
are written by this adapter. The helper pauses output at 256 KiB of unacknowledged
IPC and resumes below 64 KiB; Host acknowledgement is independent of UI presence.
Network backpressure reads from the bounded ring rather than accumulating a
subscriber queue. Input is bounded to 64 KiB per request, 32 outstanding Host
commands and 64 client commands. Timed-out input is not automatically repeated.

The client fits the PTY to the panel, supports ANSI rendering, selection,
explicit clipboard copy/paste, Ctrl+C and normal terminal input including IME.
OSC 52 clipboard writes and link activation are disabled. Clear affects the
local display only and does not stop the shell or erase the Host replay buffer.
Clipboard access still requires browser permission. Only Windows native PTY
startup has been verified locally; Linux/macOS require their own acceptance.
Dependencies are pinned and installed without lifecycle scripts. A missing or
incompatible native binary fails the terminal without taking down the Web Host;
it does not trigger an automatic download, compilation or toolchain install.

## Thinking presentation

The browser projects structured `thinking`, `text` and `toolCall` blocks in
source order, both from saved entries and live `message_update` events.
Non-redacted thinking supplied by the provider remains expandable in history;
sessions without thinking blocks do not acquire invented records. Opaque
thinking signatures and redacted blocks are never rendered.

Thinking uses the standard folded disclosure with a Brain icon. Only the
currently streaming thinking block has the tool-style running label, shimmer
and a short content preview. Text/tool output, message completion or a settled
session stops the running state and folds an open live thought. A settled
thought can be reopened manually. Reduced-motion skips folding/shimmer effects.
The host observes each block's structured thinking start/delta/end events.
The label shows DFSC-style elapsed seconds, ticks once per second only while
that block is active, and freezes before prose or tool arguments start.
Each assistant message's completed observations are saved through
`SessionManager.appendCustomEntry` as `stepcode-web.thinking-timing` metadata
(version 1, message timestamp identity and per-content-index intervals).
These custom entries do not enter model context or change provider messages.
Validated `thinkingTimings` are projected onto saved assistant entries and
live agent SSE envelopes; browser refresh and host restart restore completed
observations. No elapsed time is inferred from message timestamps, tokens or
browser receipt times. Legacy sessions and unobserved child-agent histories
show no duration. Abrupt host termination cannot reconstruct an unrecorded
interval. Metadata write failures are reported without preventing the
canonical assistant message from being persisted.

Thinking is not a tool and does not enter task/tool counts or response-copy
text. The response footer remains once per settled user turn and is revealed
only on hover or keyboard focus. Thinking timing is host-owned presentation
metadata; agent context, provider behavior and tool permissions remain unchanged.
