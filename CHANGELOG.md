# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The CLI and the server image share one version and ship from a single `v*` tag.

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

[0.2.0]: https://github.com/adityadarma/tunnelcode/releases/tag/v0.2.0
[0.1.1]: https://github.com/adityadarma/tunnelcode/releases/tag/v0.1.1
[0.1.0]: https://github.com/adityadarma/tunnelcode/releases/tag/v0.1.0
