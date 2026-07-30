# TunnelCode

Run an AI coding agent on your own machine and drive it from a browser.

TunnelCode is a bridge between the browser, a server, and a local AI agent. It is
not an IDE and not an AI provider. See `PROJECT.md` for the full specification and
`DECISIONS.md` for the architecture decisions.

## Requirements

- Node.js 22 or newer
- pnpm 11
- An engine on PATH: [OpenCode](https://opencode.ai) or Claude Code

## Install

The CLI is published to npm as a single bundled file:

```sh
npm i -g tunnelcode
```

The server is not on npm. It ships only as a Docker image, since it needs SQLite
with a native binding and a volume for its data.

To work on the project instead, from a checkout:

```sh
pnpm install
pnpm build
```

## Run

Start the server:

```sh
pnpm --filter tunnelcode-server start
```

It listens on `127.0.0.1:3000` by default and serves the web app from the same
port.

Then run the CLI from the project directory you want the agent to work in:

```sh
cd /path/to/your/project
pnpm exec tunnelcode
```

That opens a menu. Choose Setup on the first run to set the server URL, then
Continue to print a QR code and an 8 letter pairing code.

## Pairing

1. Scan the QR or open the printed URL in a browser.
2. The browser shows a 4 digit approval number.
3. The terminal shows the same number. Press `y` to approve, `n` to reject.

The approval number never travels in a URL, so a leaked link is not enough to
pair. The pairing code is single use and only valid while the CLI is running. A
session ends after one hour without conversation.

## CLI

`tunnelcode` takes no arguments and no options. Everything is chosen in the app.
See ADR-018 for why.

```
tunnelcode
  Continue   scan QR to pair
  Setup
  Exit
```

Setup holds four entries: Server URL, Device name, Engine, and Check environment.

Each field is written as soon as it is answered, so leaving the menu never
discards a change. Arrow keys and Enter move through the lists, Escape goes back.

## Configuration

Configuration is per user. There is one file:

- macOS and Linux: `~/.config/tunnelcode/tunnelcode.json`
- Windows: `%APPDATA%/TunnelCode/tunnelcode.json`

```json
{
  "server": { "url": "https://server.example.com" },
  "device": { "name": "MacBook Pro" },
  "engine": "opencode"
}
```

A project directory is never read from. The working directory decides what the
agent works in and derives its device id, but not how it is configured. See
ADR-019.

## Environment variables

The server reads a `.env` file at startup. Copy `.env.example` to `.env` to begin.
The search walks upward from the working directory, so a `.env` at the repository
root is found even though `pnpm --filter tunnelcode-server start` runs inside the
package. `ENV_FILE=/path/to/file` loads a specific file instead.

Real environment variables always win over the file, so `PORT=8080 pnpm start`
still works.

The CLI reads neither. It has no environment variables at all: every setting comes
from the Setup menu, so nothing in the surrounding shell can decide which server
the agent reports to. See ADR-018.

Read by the server:

| Variable        | Default                  | Purpose                           |
| --------------- | ------------------------ | --------------------------------- |
| `HOST`          | `127.0.0.1`              | Bind address                      |
| `PORT`          | `3000`                   | Port for HTTP and WebSocket       |
| `DATABASE_FILE` | `data/tunnelcode.sqlite` | SQLite location                   |
| `LOG_LEVEL`     | `info`                   | `fatal` through `trace`, `silent` |
| `ENV_FILE`      | nearest `.env`           | Environment file to load          |

Changing `HOST` away from `127.0.0.1` exposes an agent that can read and write
files on the paired machine. Only do that on a network you trust, and read the
Security section first.

The CLI decides which server to talk to from the stored config alone. Precedence,
most specific first: the stored config, then the URL baked in at publish time,
then `http://localhost:3000`. Change it in Setup, Server URL.

Read by the dev server (`dev:web`):

| Variable   | Default | Purpose                        |
| ---------- | ------- | ------------------------------ |
| `WEB_PORT` | `5173`  | Port Vite listens on           |
| `HOST`     | `127.0.0.1` | Proxy target host          |
| `PORT`     | `3000`  | Proxy target port              |

So a server on another port needs no file edits:

```sh
PORT=8080 pnpm --filter tunnelcode-server start
PORT=8080 pnpm --filter tunnelcode-server dev:web
```

The CLI is not in that list: point it at the new port in Setup, Server URL.

## Docker

```sh
docker build -t tunnelcode .
docker run -d -p 3000:3000 -v tunnelcode-data:/data tunnelcode
```

The image binds `0.0.0.0` inside the container, so the published port is what
controls access. Conversations live on the `/data` volume and survive a new
image. The image is Alpine based and compiles the SQLite binding at build time.

## Security

There is no user authentication in this version. Anyone who can reach the server
and complete pairing controls an agent that can read and write files on the
paired machine. The server binds to loopback by default for that reason. Put it
behind TLS and think about who can reach the port before exposing it.

## Development

```sh
pnpm build        # build every package
pnpm typecheck    # type check, including the web app
pnpm lint         # ESLint
pnpm format       # Prettier
pnpm test         # build, then run every test
```

## Tests

Server, CLI, and package tests use the built-in `node:test` runner. The web app
uses Vitest, because component tests need a DOM.

```sh
pnpm test                                  # everything
pnpm --filter tunnelcode-server test:server  # node:test only
pnpm --filter tunnelcode-server test:web     # Vitest only
```

Tests import built output, since Node's type stripping does not rewrite the `.js`
specifiers the sources use, so `pnpm test` builds first.

Every test is isolated: its own temporary SQLite file, its own temporary `HOME`,
and a server on an ephemeral port. Engines are replaced by fake executables on
`PATH`, so no test calls a real AI provider or touches your global config.

Run the web app with hot reload against a running server:

```sh
pnpm --filter tunnelcode-server dev:web
```

After changing the database schema:

```sh
pnpm --filter tunnelcode-server db:generate
```

Migrations are additive only. See `RULES.md`.

## Releasing

One tag releases both apps. The CLI and the server speak the same protocol, so a
version mismatch between them is the failure worth avoiding.

| Tag      | What it releases                                       |
| -------- | ------------------------------------------------------ |
| `v0.2.0` | the server image to GHCR, then the CLI published to npm |

```sh
git tag v0.1.0 && git push origin v0.1.0
```

The version in the tag has to match both `apps/tunnelcode-cli/package.json` and
`apps/tunnelcode-server/package.json`, or the workflow fails before it builds
anything. Bump the two together. A `workflow_dispatch` run builds both apps and
publishes neither, which is how you check a release without cutting one.

The image is pushed before the CLI is published, because a GHCR tag can be
overwritten while an npm version cannot be republished. If the image build fails,
nothing reaches npm.

The CLI is bundled into one file with esbuild. The four `@tunnelcode/*` workspace
packages are inlined, because `workspace:*` cannot be resolved from the registry
and would break `npm install` for everyone. Only `ws` and `qrcode` stay external.

```sh
pnpm --filter tunnelcode bundle   # writes apps/tunnelcode-cli/bundle
```

The default server URL is baked in at bundle time from the
`TUNNELCODE_DEFAULT_SERVER_URL` repository variable. A published CLI has no
repository to read, so the deployment it talks to has to be decided when the
artifact is built. It remains a default: it is only used until something is stored,
and the Setup menu overrides it.

```sh
TUNNELCODE_DEFAULT_SERVER_URL=https://rc.example.com pnpm --filter tunnelcode bundle
```

The server is released as a Docker image to GHCR. It is never published to npm.

Before publishing, the workflow installs the tarball outside the workspace and
runs the installed binary, which is the only way to catch a manifest that cannot
actually be installed.
