# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The CLI and the server image share one version and ship from a single `v*` tag.

## [Unreleased]

The agent now asks before it does something it will not do on its own, and the answer
comes from the phone. Until now a tool call that needed approval was simply refused,
because nobody could be asked: the turn carried on and the reply explained what it
could not do. A refusal is now a question.

### Added

- A tool call waiting for permission appears in the browser with Allow once, Always
  allow, and Deny. The card sits above the composer rather than in the transcript,
  because the agent is stopped until it is answered and a card that scrolls out of
  view is one nobody answers.
- The card lists every operation the request covers, not just the first. One request
  from opencode can carry several commands, and showing one of them would mean
  agreeing to more than was on screen.
- A request that is still waiting is shown again when a browser attaches, so a phone
  that locked mid-turn comes back to it. A request waiting in another conversation is
  surfaced too, since the machine answers one prompt at a time and it is what is
  holding the session up.
- A request nobody answers within 10 minutes is refused. The deadline comes from the
  server, so two phones cannot disagree about how long is left, and the turn survives
  the wait instead of being abandoned as a hung engine.
- Setup gains **Never allow**: rules this machine will never agree to, whatever the
  browser answers. Written as `Bash` or `Bash(rm *)`. It is a filter on what may be
  allowed, not a sandbox; it can only recognise what its patterns describe.
- Setup gains **Granted permissions**, which lists what was granted from a phone and
  can clear it. Always allow is recorded for the device in `permissions.json` next to
  the config, and it is withdrawn from the terminal rather than from the browser.

### Changed

- Claude Code is driven in streaming-input mode, with its permission prompts routed to
  the CLI. Its stdin stays open for the whole turn instead of closing after the prompt,
  which is what lets an answer travel back while the engine waits.
- opencode is no longer run through `opencode run`. That command answers permission
  requests itself and answers by rejecting them, which nothing around it can intercept.
  The CLI now starts a headless opencode server and drives it as a client. The server
  listens on localhost with a password of its own, is told to ask about every kind of
  permission it has, and is stopped when the session that needed it ends. The
  instruction to ask is passed to it inline, so nothing is written into the project.
- A refused tool call now reports the reason that actually applied: denied from the
  browser, not allowed on this machine, or nobody answered in time. All three used to
  read as the first one.

### Fixed

- A grant made for one command no longer widens into a grant for the tool. A request
  that reported nothing about what it would do was treated as covered by any rule for
  that tool, so one tap meant for `Bash(curl *)` allowed every later Bash request that
  named no target.
- A grant no longer carries a second command along. `Bash(curl *)` matched
  `curl example.com; rm -rf ~` as a single line, so the rm ran without being asked
  about. Every command in a line must now be covered, and a line containing `$( )`,
  backticks, or `<( )` is never covered, because there is no honest way to read what it
  would run.
- Never allow now looks inside a chained line as well as at it, so `Bash(rm *)` catches
  `echo hi; rm -rf ~`. Missing it there was worse than missing it on a grant, since
  this is the limit that is supposed to win.
- A session ended from the browser can no longer be used. `endedAt` was written and
  never read, so the same id could attach again afterwards and still answer a
  permission request on the machine. It is now absent everywhere a session is looked
  up, including over HTTP.
- A conversation id on its own no longer opens a transcript. `GET`, `PATCH`, and
  `DELETE` on a conversation now require the session to be presented in an
  `x-tunnelcode-session` header, and the conversation has to belong to it. A transcript
  carries the output of every tool the agent ran, which is file contents and command
  results from the machine. Entitlement is the workspace rather than the session row,
  so pairing again still reopens the same history.

### Migration

- No schema change and no migration to apply.
- The config file gains an optional `permission.deny`, defaulted to empty, so a config
  written before this release loads unchanged and refuses nothing outright.
- `permissions.json` is created next to the config the first time something is granted.
  An unreadable one is treated as no grants, which only means being asked again.

## [0.3.1] - 2026-07-31

### Fixed

- Opening a conversation whose transcript contains a tool activity with no target no
  longer blanks the page. The two ways an activity reaches the browser disagree on
  shape: a live frame omits what it does not have, while the transcript endpoint
  returns the stored row, whose empty columns are explicitly `null`. The path
  shortening tested only for `undefined`, so a `null` target reached `.split()` and
  threw during render, and with no error boundary the whole app unmounted. `target`,
  `reason`, and `output` are now typed and checked as nullable.

  The crash needed a reload or a conversation switch to appear, because a live
  activity arrives in the shape that works. An activity with no target, such as
  `TodoWrite`, is the common trigger.

## [0.3.0] - 2026-07-31

An answer is now shown as it is built rather than as one block at the end: text and
tool activity interleave in the order they happened, and the output of a tool is
readable in the browser.

### Added

- Tool execution output (bash output, file reads) is shown inline in the chat, so the
  result of an action is readable without leaving the browser.

### Changed

- Message streaming interleaves text and tool activity chronologically. The CLI emits
  `turn_message` right before it runs a tool, flushing the text buffered so far, and
  the browser orders every event by time.
- Tool activity targets are shown relative to the workspace (`./`) instead of as
  absolute paths.
- Tool activity targets scroll horizontally, so a long chained command no longer
  stretches the layout.
- The composer and layout containers resize correctly when a mobile virtual keyboard
  opens.
- The typing indicator shows three animated dots. They were already in the markup but
  had no styling, so only the `typing…` label was visible.

### Fixed

- The typing indicator no longer disappears while the agent runs a tool. It was
  cleared by every stored assistant message, and since a turn now stores its text
  each time it pauses to call a tool, the indicator went down for the whole length of
  that call: the longer the wait, the longer there was no sign of work. Only
  `turn_done` ends it now. A message arriving with no turn running still raises
  nothing, so the composer cannot be left blocked by a late frame.

### Migration

- `activities` gains a nullable `output` column, applied automatically at startup. No
  table is rebuilt and no row is rewritten. An activity recorded before this release
  has no output and renders as it did before.

## [0.2.1] - 2026-07-30

### Changed

- Re-designed the landing page and empty conversation state for a more modern, glassmorphic UI.
- Fixed a bug where terminal activities (e.g. bash commands) were occasionally misordered relative to chat messages due to incorrect newline splitting logic.
- Improved overall mobile responsiveness.

## [0.2.0] - 2026-07-30

The engine is now chosen in the browser rather than in the terminal, once per
conversation. Existing conversations keep working: one created before this release
falls back to the engine of the session it was paired in.

### Added

- The engine is chosen in the browser, once per conversation. The CLI offers every
  engine that is both supported here and installed on the machine, so a choice made
  in the browser can always be served. See ADR-020.
- Each conversation records the engine it runs on and the model it asks for, and the
  conversation list shows both.
- `New` opens a dialog that asks for the engine and the model before starting a
  conversation. Both are asked together because the engine cannot be changed
  afterwards, and the model list follows the engine that is selected.
- The model of a conversation can be changed at any time, within that conversation's
  engine.
- Tailwind CSS v4, through the `@tailwindcss/vite` plugin. See ADR-021.

### Changed

- The engine named in Setup is now what a new conversation starts on, rather than the
  engine every prompt runs through. A configured engine that is not installed is
  skipped in favour of one that is. Amends ADR-018 and ADR-019.
- A conversation keeps its engine for life. Changing it is refused, because the
  agent's context lives in an engine session and switching would abandon it silently.
- A browser prompt no longer carries the engine or the model. The server reads both
  from the conversation, so two tabs cannot disagree about which engine answers.
- The session detail reports every installed engine with its own models, instead of
  one engine and one flat model list.
- A CLI with no installed engine reports that instead of starting a session.
- The model picker sits in the composer footer rather than the page header, so the
  control that decides how a prompt is answered lives next to the prompt itself.
- The model picker stays visible when an engine reports no models, showing `Engine
  default` instead of hiding. A picker that disappeared read as a missing feature
  rather than as an engine with nothing to choose between.
- The model picker lists only real models once an engine reports any. `Engine
  default` is no longer offered alongside them, since the conversation already
  carries a model by then.
- The new conversation dialog renders through a portal onto `document.body`, so it
  centres on the viewport instead of being confined by the mobile sidebar transform.
- The stylesheet was rebuilt on Tailwind and CSS variables, roughly halving its size.
  Layouts constrain horizontal overflow (`min-width: 0`, `overflow-wrap: anywhere`)
  so narrow portrait screens neither scroll sideways nor clip message text.

### Removed

- `WEB_PORT`. The Vite dev server listens on 5173, and the variable was only ever
  read there.

### Migration

- The database gains two nullable columns on `conversations`, applied automatically
  at startup. No table is rebuilt and no row is rewritten.
- A conversation created before this release has no engine of its own and answers on
  the engine of its session, exactly as it did before.
- The `engine` setting in Setup keeps its meaning as a name, but it now decides only
  what a new conversation starts on. No config file needs editing.

## [0.1.1] - 2026-07-30

### Changed

- `engine` is the only name the config accepts for the engine setting. The schema
  no longer rewrites a `defaultEngine` field left by a pre-release build, so a
  config carrying the old name fails validation instead of being migrated. See
  ADR-019.
- The menu, prompts, and Setup confirmations are colored, and the selected choice
  is marked with `❯`. Color is dropped when stdout is not a TTY, when `NO_COLOR`
  is set, or when `TERM` is `dumb`, so piped output stays plain.
- The environment check renders as a single framed panel with a pass or fail mark
  per line, and reports the config path and its status on one line rather than two.

### Removed

- The decorative `⚡` glyph before tool activity in the web app. The tool name and
  its target already carry the meaning.

## [0.1.0] - 2026-07-30

First release. TunnelCode runs an AI coding agent on your own machine and lets you
drive it from a browser. It is not an IDE and not an AI provider, only the bridge
between the browser, a server, and a local agent.

### Added

#### Pairing

- Out-of-band pairing. Continue prints a QR code and an eight letter code; the
  browser then shows a four digit approval number that the terminal confirms. The
  approval number never travels in the URL, so a leaked link is not enough to pair.
- Single use pairing codes, valid only while the CLI is running. Pending requests
  expire after two minutes. Both the code and the approval number come from the
  crypto random source.
- Sessions end after one hour without a conversation.

#### CLI

- `tunnelcode` takes no arguments and no options. It opens a menu with Continue,
  Setup, and Exit, so every setting is chosen in the app. See ADR-018.
- Setup holds the server URL, the device name, the engine, and an environment
  check reporting platform, Node version, the config path, the target server, and
  whether the engine is on `PATH`.
- Each setting is written as soon as it is answered, so leaving the menu never
  discards a change. A first change writes a complete config rather than only the
  field that was touched.
- A server URL that is not `http` or `https` is refused at the prompt instead of
  failing later when the socket cannot be opened.
- Shipped as a single bundled file on npm, so `npm i -g tunnelcode` pulls only
  `ws` and `qrcode` as runtime dependencies.

#### Engines

- Adapters for [OpenCode](https://opencode.ai) and Claude Code, resolved from
  `PATH`.
- Streaming engine events: deltas, logs, tool activity, session handoff, blocked
  actions, completion, and failure.
- Model listing per engine, surfaced in the browser as a picker.
- The engine is chosen once per user, in Setup.

#### Server

- Fastify server that serves the API, the WebSocket endpoints, and the built web
  app from one port. Binds `127.0.0.1` by default.
- `GET /health` readiness probe that actually queries the database, so a container
  that cannot read its volume reports unhealthy instead of accepting traffic.
- REST endpoints for sessions, conversations, and messages, plus
  `GET /pair/:requestId/status`.
- WebSocket endpoints `/ws/cli` and `/ws/browser`, with a turn relay that streams
  agent output to the browser as it arrives.
- Heartbeats every 30 seconds to drop dead connections. A device that goes offline
  mid-answer ends its open turns and the browser is told why, rather than waiting
  on a reply that will never arrive.
- A failed turn keeps whatever the engine already said, stored as a partial
  message so a reload does not make the work look like it never happened.
- Global rate limit of 100 requests per minute.
- Structured logging with a configurable `LOG_LEVEL`.
- Graceful shutdown that stops accepting work before closing.

#### Storage

- SQLite through Drizzle, with five additive migrations applied at startup.
- Tables for devices, sessions, conversations, messages, and activities.
- Conversation history survives restarts, including partial messages from an
  interrupted answer.
- Audit trail of tool activity per conversation, recording the tool, its target,
  whether the action was blocked, and why.

#### Web app

- React app for pairing and conversations, served by the server itself.
- Conversation list with create and delete, a composer, and a streaming message
  list.
- Device panel, model picker, and a light and dark theme toggle. Session, active
  conversation, selected model, and theme are all remembered across reloads.
- Blocked agent actions are shown inline with their reason, so a refused write is
  visible rather than silent.

#### Configuration

- Configuration is per user, in one file: `~/.config/tunnelcode/tunnelcode.json`,
  or `%APPDATA%/TunnelCode/tunnelcode.json` on Windows. A project directory is
  never read from. See ADR-019.
- The working directory decides what the agent works in and derives its device id,
  but not how it is configured.
- The server reads a `.env` file at startup, searching upward from the working
  directory so a file at the repository root is found. `ENV_FILE` loads a specific
  file instead, and real environment variables always win.
- Server variables: `HOST`, `PORT`, `DATABASE_FILE`, `LOG_LEVEL`.
- The CLI has no environment variables and does not read `.env`. It resolves the
  server from the stored config, then the URL baked in at publish time, then
  `http://localhost:3000`.
- Dev server variables: `HOST`, `PORT`.

#### Packaging

- Alpine based Docker image for the server, published to GHCR. The SQLite binding
  is compiled at build time against the runtime libc, and conversations live on
  the `/data` volume.
- `docker-compose.yml` for a single container deployment.
- Release workflow driven by one `v*` tag: the image is pushed to GHCR first,
  then the CLI is published to npm with provenance. The image ships first because
  a GHCR tag can be overwritten while an npm version cannot be republished.
- The workflow refuses to build unless the tag matches both app manifests, and
  it installs the packed tarball outside the workspace to prove the published
  manifest is installable.

### Security

- There is no user authentication in this release. Anyone who can reach the server
  and complete pairing controls an agent that can read and write files on the
  paired machine. The server binds to loopback for that reason. Put it behind TLS
  and restrict who can reach the port before exposing it.
- The server the agent reports to and the engine it runs cannot be changed by a
  flag, an environment variable, or a file inside a project. The agent reads and
  writes files on the machine it runs on, so both are deliberate answers to a
  visible prompt rather than something the surrounding shell or a cloned repository
  can decide.

[0.3.0]: https://github.com/adityadarma/tunnelcode/releases/tag/v0.3.0
[0.2.1]: https://github.com/adityadarma/tunnelcode/releases/tag/v0.2.1
[0.2.0]: https://github.com/adityadarma/tunnelcode/releases/tag/v0.2.0
[0.1.1]: https://github.com/adityadarma/tunnelcode/releases/tag/v0.1.1
[0.1.0]: https://github.com/adityadarma/tunnelcode/releases/tag/v0.1.0
