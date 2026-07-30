# RemoteCode Development Tasks

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

Build the remotecode CLI application.

### Tasks

- [x] CLI entrypoint
- [x] CLI argument parser
- [x] Command: setup
- [x] Command: init
- [x] Command: doctor
- [x] Command: start

Acceptance

- remotecode runs

---

# Milestone 3 — Configuration

## Goal

Build the configuration loader.

### Tasks

- [x] Global config loader
- [x] Workspace config loader
- [x] Config validation
- [x] Config merge
- [x] Config writer

Acceptance

Global config

~/.config/remotecode/remotecode.json

Workspace config

.remotecode/config.json

---

# Milestone 4 — Engine

## Goal

Run OpenCode through an adapter.

### Tasks

- [x] Engine interface
- [x] OpenCode adapter
- [x] Claude Code adapter
- [x] Engine registry
- [x] Spawn process
- [x] Stream stdout
- [x] Stream stderr

Acceptance

OpenCode can be started from the CLI.

Claude Code can be started from the CLI.

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

The model picker only offers models from the engine chosen in the terminal.

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
