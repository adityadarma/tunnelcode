# TunnelCode Development Tasks

Status: MVP
Version: 1.0

---

# Rules

- Work through tasks in order.
- Do not skip milestones.
- Do not build features outside the MVP.
- Do not do large refactors before all milestones are done.
- Every task must produce runnable code.

---

# Milestone 1 — Project Foundation

## Goal

Create the project structure and workspace.

### Tasks

- [x] Initialize pnpm workspace
- [x] Create apps/ folder
- [x] Create packages/ folder
- [x] Set up TypeScript
- [x] Set up ESLint
- [x] Set up Prettier
- [x] Set up shared tsconfig
- [x] Set up build script

Acceptance

- The project installs with pnpm install
- Every package builds

---

# Milestone 2 — CLI

## Goal

Build the tunnelcode CLI application.

### Tasks

- [x] CLI entrypoint
- [x] Start the agent for the current workspace
- [x] Report the environment

Acceptance

- tunnelcode runs

---

# Milestone 3 — Configuration

## Goal

Build the configuration loader.

### Tasks

- [x] Config loader
- [x] Config validation
- [x] Config writer

Acceptance

Configuration is per user, in one file. See ADR-019.

~/.config/tunnelcode/tunnelcode.json

%APPDATA%/TunnelCode/tunnelcode.json on Windows

---

# Milestone 4 — Engine

## Goal

Run OpenCode through an adapter.

### Tasks

- [x] Engine interface
- [x] OpenCode adapter
- [x] Claude Code adapter
- [x] Antigravity CLI adapter
- [x] Kiro CLI adapter
- [x] Engine registry
- [x] Spawn process
- [x] Stream stdout
- [x] Stream stderr

Acceptance

OpenCode can be started from the CLI.

Claude Code can be started from the CLI.

Antigravity CLI can be started from the CLI. It answers, reports its tool calls, and
continues an earlier conversation. It raises no permission ask, and a call its policy
refuses is reported as blocked rather than run. See ADR-031.

Kiro CLI can be started from the CLI. It answers, reports its tool calls, continues an
earlier conversation, and raises a permission ask that reaches the browser. See
ADR-034.

---

# Milestone 5 — Server

## Goal

Build the backend.

### Tasks

- [x] Fastify
- [x] WebSocket
- [x] Health endpoint
- [x] Pair endpoint
- [x] Rate limit on the pair endpoint
- [x] Approval number (4 digits, server generated)
- [x] Session service
- [x] Device service

Acceptance

The CLI can connect.

A pair request creates a pending approval and never pairs on its own.

---

# Milestone 6 — Pairing

## Goal

Let the CLI perform pairing.

### Tasks

- [x] Generate code (8 uppercase letters A-Z, case sensitive)
- [x] Generate QR
- [x] Connect WebSocket
- [x] Wait for pairing
- [x] Show the approval number in the terminal
- [x] Approve or reject with a single keypress
- [x] Connected state
- [x] Single use code
- [x] Idle timeout of 1 hour
- [x] CLI exits when expired

Acceptance

The browser pairs successfully after the user approves in the terminal.

A request that is not approved never pairs.

---

# Milestone 7 — Database

## Goal

Persistence.

### Tasks

- [x] SQLite
- [x] Drizzle
- [x] Migration
- [x] Conversation table
- [x] Message table
- [x] Session table
- [x] Device table

Acceptance

Conversations are stored.

---

# Milestone 8 — Web

## Goal

Browser UI.

### Tasks

- [x] React
- [x] Vite
- [x] Serve the built web app from the server
- [x] Login page reading the code from the QR URL
- [x] Approval number page
- [x] Waiting and rejected states
- [x] Conversation layout (message list, composer, roles)
- [x] Conversation list
- [x] Device page
- [x] Model list reported by the engine the terminal chose
- [x] Model picker in the conversation

Acceptance

The browser pairs through the UI, showing the approval number.

The conversation layout renders stored history.

The model picker only offers models the conversation's engine reported.
Superseded in part by Milestone 14: the engine is chosen in the browser now.

---

# Milestone 9 — Streaming

## Goal

Realtime streaming.

### Tasks

- [x] Forward prompt
- [x] Receive delta
- [x] Stream to browser
- [x] Buffer response
- [x] Save final message

Acceptance

Streaming works.

---

# Milestone 10 — Polish

### Tasks

- [x] Error handling
- [x] Logging
- [x] Reconnect
- [x] Health check
- [x] Docker
- [x] Documentation

Acceptance

MVP done.

---

# Milestone 11 — Test Suite

## Goal

Protect the behaviour the MVP already has, so a later change cannot break it
silently.

### Tasks

- [x] Test runner (node:test, no new dependency)
- [x] Test script per package and at the root
- [x] Unit: pairing code generator (shape, uniqueness, crypto source)
- [x] Unit: approval number generator (4 digits, leading zero kept)
- [x] Unit: config loader, merge, and writer
- [x] Unit: device id derivation is stable per workspace
- [x] Unit: idle timer resets on activity and not on heartbeats
- [x] Unit: engine adapters map real output shapes to events
- [x] Unit: OpenCode cumulative text is de-duplicated
- [x] Unit: device service reconnect keeps the paired flag
- [x] Unit: session service approval, rejection, and expiry
- [x] Integration: pair endpoint, rate limit, and single use code
- [x] Integration: only the owning CLI can approve
- [x] Integration: prompt refused while the agent is busy is not stored
- [x] Integration: streaming relays deltas and stores one final message
- [x] Integration: history survives a server restart
- [x] Migration test: an existing database keeps its rows
- [x] UI: pairing screen, model picker, composer, conversation list, message list
- [x] CI workflow running build, lint, typecheck, format, and tests

Acceptance

`pnpm test` passes from a clean checkout.

Every bug fixed during development has a test that fails without the fix.

Tests use a temporary database and a fake engine, never the real engines or the
real global config.

---

# Milestone 12 — Turn Recovery

## Goal

Make a refresh mid-answer recoverable, and stop a hung engine from holding the
device forever. See ADR-017.

### Tasks

- [x] Report the running turn in the attach reply
- [x] Disable the composer when a turn is already running
- [x] Say which conversation the agent is busy in
- [x] Abandon a turn after engine silence, cancelling the engine process
- [x] Report an abandoned turn as an error, never as a finished answer
- [x] Explain in the refusal that the earlier answer is still coming
- [x] Unit: a silent engine is cancelled, a talkative slow one is not
- [x] Integration: attaching mid-answer reports the running turn
- [x] UI: a reported turn blocks the composer and releases it when done

Acceptance

Refreshing while an answer is streaming shows the answer once it finishes, without
the next prompt being refused for no visible reason.

An engine that stops responding ends its turn instead of blocking the device.

---

# Milestone 13 — In-App Menu

## Goal

Make the app the only place the CLI is configured, so neither the surrounding shell
nor a file inside a project can decide what the agent does. See ADR-018 and
ADR-019.

### Tasks

- [x] Terminal list and text prompts, no new dependency
- [x] Main menu: Continue, Setup, Exit
- [x] Setup menu: server URL, device name, engine, check environment
- [x] Write each setting as soon as it is answered
- [x] Refuse a server URL that is not http or https
- [x] The CLI takes no arguments and no options
- [x] The CLI does not read .env
- [x] The CLI does not read TUNNELCODE_SERVER_URL, HOST, or PORT
- [x] One config per user, no project config
- [x] One engine setting, named engine
- [x] Reject any engine setting not named engine
- [x] Report the working directory without reading a config from it
- [x] Menu tests driving the real process
- [x] Test: the environment cannot point the agent at another server
- [x] Test: a config file in the working directory is ignored
- [x] Test: a config naming the engine anything else is rejected

Acceptance

`tunnelcode` with no arguments opens the menu.

Nothing in the environment can change which server the agent connects to.

Setup offers one engine setting.

A config file left in a project directory changes nothing.

`engine` is the only name the config accepts for the engine setting.

---

# Milestone 14 — Engine Per Conversation

## Goal

Let the browser choose which engine answers, from the engines the machine actually
has, without letting a running conversation lose its context. See ADR-020.

### Tasks

- [x] Discover the engines that are both supported and installed on PATH
- [x] Register every installed engine with its own models
- [x] Refuse to start a session when no engine is installed
- [x] Setup engine becomes the engine a new conversation starts on
- [x] Record the engine and the model on the conversation
- [x] Choose the engine when creating a conversation, never after
- [x] Change the model of an existing conversation
- [x] Resolve engine and model on the server, not from the prompt
- [x] Route each prompt to the engine its conversation names
- [x] Show the engine and model of every conversation in the list
- [x] Unit: discovery reports only the intersection, with per-engine models
- [x] Unit: a prompt naming an uninstalled engine fails its turn
- [x] Unit: a device lookup validates a model against its own engine
- [x] Integration: a model belonging to another engine is refused
- [x] Integration: a conversation keeps its engine across prompts
- [x] Integration: the model can be changed, the engine cannot
- [x] UI: one engine creates directly, several offer a choice

Acceptance

The browser starts a conversation on any engine the paired machine has installed.

A conversation answers on that engine for its whole life, so the agent never
silently loses the context it built up.

The model can be changed within the conversation's engine.

A machine with no installed engine says so instead of pairing.

---

# Milestone 15 — Responsive UI & Tailwind CSS v4

## Goal

Integrate Tailwind CSS v4 and refine the web app frontend so it looks modern, feels like an IDE chat UI, and is fully responsive on desktop and mobile portrait/landscape screens. See ADR-021.

### Tasks

- [x] Integrate `@tailwindcss/vite` and `tailwindcss` v4 into web app build
- [x] Position ModelPicker inside the prompt composer box footer (IDE prompt box)
- [x] Ensure ModelPicker is always visible even when models array is empty
- [x] Prevent horizontal scrolling and text clipping on mobile screens (`min-width: 0`, `overflow-wrap: anywhere`)
- [x] Optimize small portrait screen (< 360px) layout with compact send icon button
- [x] Build and test web app with zero regression

Acceptance

The web UI is styled with Tailwind CSS v4 and maintains 100% responsiveness without horizontal overflow across mobile portrait and landscape viewports.

---

# Milestone 16 — Interactive Permission

## Goal

Turn a refusal into a question. A tool call the engine will not run on its own is
asked to the browser, and the answer returns to the turn that asked. See ADR-022.

### Tasks

- [x] Permission request and decision events in the protocol
- [x] Claude Code driven in streaming-input mode, with its asks routed to the CLI
- [x] opencode driven as a client of a headless server, since `opencode run` refuses on
      its own
- [x] The opencode server gets a password of its own and is told to ask about every
      permission kind it has
- [x] The instruction to ask is passed inline, so nothing is written into the project
- [x] The browser shows Allow once, Always allow, and Deny above the composer
- [x] The card lists every operation one request covers, not just the first
- [x] A request still waiting is shown again when a browser attaches, including one
      waiting in another conversation
- [x] A request nobody answers within 10 minutes is refused, on a deadline the server
      owns
- [x] The silence timeout stops while a person is being asked
- [x] Always allow is recorded for the device in `permissions.json`, next to the config
- [x] Setup lists granted rules and can clear them; the browser cannot
- [x] Setup names a Never allow ceiling, filtering asks before they are sent
- [x] A grant covers every command in a chained line, and never covers a line carrying
      `$( )`, backticks, or `<( )`
- [x] A refused call is stored as a blocked activity, naming the reason that applied
- [x] An answer is bound to its turn and accepted only from the session that owns it
- [x] Unit: rule parsing, matching, the ceiling, and what a grant records
- [x] Unit: an ask nobody can answer, or a caller that throws, is refused
- [x] Integration: expiry, relay, and replay on attach
- [x] UI: the permission card and its three answers

Acceptance

A tool call needing approval reaches the phone instead of failing silently.

Nothing is allowed by a deadline passing.

A rule the ceiling forbids is never offered as a choice.

---

# Milestone 17 — Subagent Work

## Goal

Make a turn that fans out into subagents report what it is doing, and stop it being
abandoned as a hung engine while the work is happening. See ADR-023.

### Tasks

- [x] Adopt the sessions opencode starts under a session the turn already owns
- [x] Report a subagent's tool calls as activities of the turn that started it
- [x] Answer a subagent's permission ask on the session that raised it
- [x] Keep a subagent's narration out of the answer
- [x] Only the prompted session ends the turn, or fails it
- [x] A session parented outside the turn stays foreign
- [x] Show a description as the target when nothing else in the call is readable
- [x] Stop cutting a target to 120 characters with an ellipsis
- [x] Drop the workspace prefix from a target instead of writing `./`
- [x] Unit: nested activity, nested asks, nested idle, and a foreign session
- [x] UI: a workspace path inside a command, the workspace on its own, and a long
      target kept whole

Acceptance

A turn spawning several subagents keeps reporting activity, and is not cancelled
while its subagents are working.

A subagent's shell command reaches the phone as an ask, like any other.

A path in a transcript reads as it does in an editor, and a command is never cut.

---

# Milestone 18 — Hardening

## Goal

Close the gaps an audit of the released server found: a session that never expired,
a rate limit anyone could reset, a socket that accepted any page, and files readable
by every account on the machine. See ADR-026 through ADR-029.

### Tasks

- [x] Store the last conversation activity on the session row
- [x] Refuse a session after an hour without activity, in the one place every caller
      reads it through
- [x] Count a prompt, an answer, engine work, and a decided ask as activity
- [x] Do not count heartbeats, browser attaches, or individual deltas
- [x] Remove the in-memory activity timestamp nothing ever read
- [x] Trust forwarded client addresses only when `TRUST_PROXY` says so
- [x] Refuse a WebSocket handshake whose Origin is not a host the request was
      addressed to, before the upgrade, on both sockets
- [x] Accept a handshake with no Origin, which is what the CLI sends
- [x] Write the config, the grants, and the machine id as 0600 in a 0700 directory
- [x] Correct the mode on every write, not only on creation
- [x] Unit: idle expiry, activity refreshing it, the fallback for rows written before
      the column, and an ended session staying ended
- [x] Unit: origin matching, including `null`, a malformed value, and a forwarded host
- [x] Integration: a prompt records activity and attaching does not
- [x] Integration: a forwarded address cannot reset the pairing limit, and a trusted
      proxy still can tell its clients apart
- [x] Integration: both sockets refuse a foreign origin and accept their own page
- [x] Unit: every file this machine writes is owner-only, including one left loose by
      an earlier install
- [x] Give a prompt a maximum length and refuse anything longer
- [x] Give engine output a larger maximum, and shorten it in the CLI so a turn is
      never lost to a refused frame
- [x] Refuse a WebSocket frame larger than the longest legal message, before parsing
- [x] Say in the composer that a prompt is too long, rather than leaving the server to
      answer "invalid message"
- [x] Unit: both limits at the boundary and one past it, and that a shortened message
      still parses
- [x] Integration: an oversized frame closes the socket with 1009

Acceptance

A leaked session id stops working an hour after the conversation went quiet, and a
server restart does not give it another hour.

Guessing pairing codes cannot be made free by writing a header.

A page the user merely visited cannot open a socket to the agent.

Nothing this machine writes is readable by another account on it.

No message can write an unbounded amount into the database, and no legitimate turn is
lost to the limit that stops it.

---

# Milestone 19 — Kiro Engine

## Goal

Add Kiro CLI as an engine that can be asked, and pin it to what the real CLI does
rather than to what its protocol allows. See ADR-034.

### Tasks

- [x] Kiro adapter driven over ACP, with the JSON-RPC transport in a file of its own
- [x] Register kiro with its own models, appended so Setup answers by position still hold
- [x] Route an ask to the browser and answer it on the request that raised it
- [x] Name a tool as Kiro names it, not by the coarser protocol kind
- [x] Take what a call would do from the update that announced it, keyed by tool call id
- [x] Report no separate operations for an ask that covers one call
- [x] Leave a refusal decided here to be reported once, by the CLI that knows the reason
- [x] Continue a conversation with the load method the CLI implements
- [x] Relay nothing while a load replays the transcript
- [x] Apply the model chosen in the browser to the session, per turn
- [x] Keep a turn whose model was refused, saying so as a log
- [x] Read model ids from the fields the listing actually uses
- [x] Read the plain listing by its credit column, so the default model is kept
- [x] Ask whether anyone is logged in before listing models
- [x] Report a missing login only when the engine's words say so
- [x] Decline the file system and terminal capabilities
- [x] Unit: streaming, thinking, tool calls, asks, load, model, listing, and failures
- [x] Unit: a quota failure is reported as itself, not as a missing login
- [x] Unit: the model list is never asked for without a login

Acceptance

A conversation on Kiro answers, reports what it did, and remembers what was said in
earlier turns.

A shell command Kiro will not run alone reaches the phone as an ask, and a refusal is
stated once.

Starting the CLI never opens a login page, and a machine with no Kiro login still
offers its other engines.

A failure Kiro reports is read in its own words, so a quota problem is not answered
with a login.

---

# Milestone 20 — Reported Thinking

## Goal

Keep what the model was working out instead of dropping it, without letting it be
read as the answer. See ADR-037.

### Tasks

- [x] Reasoning event in the engine contract, separate from a delta
- [x] opencode reports its reasoning parts, streamed and whole
- [x] Claude reports its thinking blocks
- [x] Kiro reports its thought chunks

- [x] Nothing invented for Antigravity, which counts its thinking and never sends it
- [x] Unit: a recorded Antigravity run on a thinking model reports work, not thinking
- [x] Fragments relayed live, the stretch stored when the model stops thinking
- [x] Thinking flushed before the answer or the tool call that closed it off
- [x] A turn that fails mid-thought keeps what it was working out
- [x] Its own table, its own record, placed on the timeline by time
- [x] Thinking travels with the transcript, so a refresh restores the fold
- [x] The browser shows it folded and closed, saying in words which state it is in
- [x] A browser attaching mid-thought is given the stored stretch, not the fragments
- [x] Unit: every adapter that can report thinking keeps it out of the answer
- [x] Unit: flush order, live relay, and a failure mid-thought
- [x] Integration: relayed, stored, reloaded, and never written by another device
- [x] Migration test: an existing database gains the table and keeps its rows
- [x] UI: the fold is closed, opens on demand, and is placed before what it led to
- [x] The running turn names what it is doing, from the last thing it reported
- [x] A verb read from the tool name, with a general word for one nothing recognises
- [x] A finished call, and a stored paragraph, hand the line back to thinking
- [x] Unit: the verbs, the overlapping names, the unknown tool, and every turn state
- [x] UI: a running call is named, and a finished one is not

Acceptance

A turn that thinks for a long time says so while it happens, instead of looking
stalled.

The answer never carries the deliberation, and a reader who wants the working can
open it.

A refresh brings the thinking back with the rest of the transcript.

An engine that reports no thinking is unaffected, and its turns still say what they
are doing, because that is read from the tool calls every engine reports.

---

# Milestone 21 — Token Usage

## Goal

Show how much a turn cost, when the engine can say so. See ADR-046.

### Tasks

- [x] `EngineUsage` event in the engine contract (`type: 'usage'`)
- [x] Claude Code adapter emits usage from the result line
- [x] Antigravity adapter emits usage from tool step metrics
- [x] Kiro adapter emits usage from session response metadata
- [x] Accumulate usage across multiple events per turn in the prompt runner
- [x] Carry usage on `turn_done` from CLI to server (optional field)
- [x] Relay usage on `turn_done` from server to browser (optional field)
- [x] `TokenUsage` component displaying a compact pill with input/output counts
- [x] Show the pill in the conversation page beside the model name

Acceptance

A turn that reports usage shows how many tokens went in and came out, formatted
compactly.

A turn whose engine does not report usage shows nothing extra.

The count is accumulated per turn, so an engine reporting per step still shows one
total.

---

# Milestone 22 — Self-Update & Background Check

## Goal

Let the CLI update itself and tell the user when a newer version exists. See ADR-047.

### Tasks

- [x] `tunnelcode update` command: check the npm registry, detect the package manager,
      install globally
- [x] Semver comparison utility (`isNewer`)
- [x] Package manager detection from the global install path
- [x] Background update check after session ends, non-blocking
- [x] Notice printed to the terminal when a newer version exists
- [x] Network failure or timeout silently skipped
- [x] Sleep prevention (`Caffeinate` class) started on session start, stopped on end
- [x] macOS: `caffeinate -i`
- [x] Linux: `systemd-inhibit` with idle lock
- [x] Windows: PowerShell `SetThreadExecutionState` loop

Acceptance

`tunnelcode update` installs the latest version from npm.

A session that ends without an update available says nothing extra.

A session that ends when a newer version exists prints a notice naming both versions
and the command to run.

The machine does not sleep idle while a session is running.

---

# Milestone 23 — Hardening (Round 2)

## Goal

Close edge cases found after the install banner and permission rules shipped.

### Tasks

- [x] Strip NUL bytes from permission rule globs before compiling the regex
- [x] Rate limit the pair status polling endpoint (60/min per client)
- [x] Guard install banner against missing `beforeinstallprompt` and unsupported
      notification/service-worker APIs
- [x] Unit: a glob with a NUL byte still matches or rejects correctly
- [x] README: add npm, CI, and license badges

Acceptance

A crafted rule cannot corrupt the regex matcher.

A misbehaving browser cannot flood the status endpoint.

The install banner degrades gracefully on browsers that do not support installation.


---

# Milestone 24 — File Changes Page

## Goal

Show real-time git workspace changes in the browser, with a diff viewer modeled after
VS Code's source control panel. The user sees which files changed and can read each
diff without switching to a terminal.

### Tasks

- [x] `file_changes` message type in `cliMessageSchema` (CLI → Server)
- [x] `file_changes` message type in `serverToBrowserMessageSchema` (Server → Browser)
- [x] `FileWatcher` class in the CLI: polls `git status --porcelain` every 5 seconds
- [x] Only send updates when the snapshot actually changes
- [x] Enrich each changed file with its `git diff` (staged or working tree)
- [x] Normalize git porcelain status (`??` → `U`, first char otherwise)
- [x] Start the watcher on pair and on reconnect, stop on session end
- [x] Server handler: cache last `file_changes` per device, broadcast to browsers
- [x] Send cached file changes immediately on browser attach
- [x] Clean up cache when a device disconnects
- [x] `/file-changes` client-side route with `useRoute` integration
- [x] `FileChangesPage` component: WebSocket-connected, real-time updates
- [x] Split layout: sidebar (file list) + content area (diff viewer), CSS Grid
- [x] Custom diff parser: line numbers, hunk headers, additions/deletions
- [x] Diff table with gutter numbers, markers, and color-coded rows
- [x] File status icons and labels (Modified, Added, Deleted, Untracked)
- [x] Responsive: stacks vertically on mobile
- [x] Navigation button in conversation header
- [x] Live/offline connection indicator
- [x] Full file view via `git diff -U9999` (all lines visible, changes highlighted)
- [x] Auto-scroll to first change when selecting a file
- [x] Per-file counters in sidebar: `+N` added, `-N` deleted
- [x] Mobile drawer: sidebar slides in from left, overlay dismisses, file select closes
- [x] Hamburger button visible only on mobile, matches conversation page pattern

Acceptance

Opening the file-changes page shows which files have uncommitted changes, immediately
and without polling from the browser.

Each file's diff is rendered with line numbers and color, like a code review.

The list updates within seconds of a file being saved on the paired machine.

A workspace with no changes shows a clean state rather than an empty list.
