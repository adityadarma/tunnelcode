# RemoteCode

Run an AI coding agent on your own machine and drive it from a browser.

RemoteCode is a bridge between the browser, a server, and a local AI agent. It is
not an IDE and not an AI provider. See `PROJECT.md` for the full specification and
`DECISIONS.md` for the architecture decisions.

## Requirements

- Node.js 22 or newer
- pnpm 11
- An engine on PATH: [OpenCode](https://opencode.ai) or Claude Code

## Install

The CLI is published to npm as a single bundled file:

```sh
npm i -g remotecode
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
pnpm --filter remotecode-server start
```

It listens on `127.0.0.1:3000` by default and serves the web app from the same
port.

Configure the machine once, then start the agent from any project directory:

```sh
pnpm exec remotecode setup --server http://127.0.0.1:3000
cd /path/to/your/project
pnpm exec remotecode init --engine opencode
pnpm exec remotecode start
```

`start` prints a QR code and an 8 letter pairing code.

## Pairing

1. Scan the QR or open the printed URL in a browser.
2. The browser shows a 4 digit approval number.
3. The terminal shows the same number. Press `y` to approve, `n` to reject.

The approval number never travels in a URL, so a leaked link is not enough to
pair. The pairing code is single use and only valid while the CLI is running. A
session ends after one hour without conversation.

## CLI

| Command             | Purpose                             |
| ------------------- | ----------------------------------- |
| `remotecode`        | Start the agent (same as `start`)   |
| `remotecode setup`  | Write the global configuration      |
| `remotecode init`   | Write the workspace configuration   |
| `remotecode doctor` | Check the environment               |

Useful flags: `--server`, `--device`, `--engine`, `--force`, and `--prompt` to run
one prompt without pairing.

## Configuration

Global, per machine:

- macOS and Linux: `~/.config/remotecode/remotecode.json`
- Windows: `%APPDATA%/RemoteCode/remotecode.json`

Workspace, per project: `.remotecode/config.json`. The workspace engine overrides
the global default, so each project can use a different engine.

## Environment variables

Both the server and the CLI read a `.env` file at startup. Copy `.env.example` to
`.env` to begin. The search walks upward from the working directory, so a `.env` at
the repository root is found even though `pnpm --filter remotecode-server start`
runs inside the package. `ENV_FILE=/path/to/file` loads a specific file instead.

Real environment variables always win over the file, so `PORT=8080 pnpm start`
still works.

Read by the server:

| Variable        | Default                  | Purpose                           |
| --------------- | ------------------------ | --------------------------------- |
| `HOST`          | `127.0.0.1`              | Bind address                      |
| `PORT`          | `3000`                   | Port for HTTP and WebSocket       |
| `DATABASE_FILE` | `data/remotecode.sqlite` | SQLite location                   |
| `LOG_LEVEL`     | `info`                   | `fatal` through `trace`, `silent` |
| `ENV_FILE`      | nearest `.env`           | Environment file to load          |

Changing `HOST` away from `127.0.0.1` exposes an agent that can read and write
files on the paired machine. Only do that on a network you trust, and read the
Security section first.

Read by the CLI to decide which server to talk to:

| Variable                | Default                  | Purpose                          |
| ----------------------- | ------------------------ | -------------------------------- |
| `REMOTECODE_SERVER_URL` | built from host and port | Full server URL, wins over both  |
| `HOST`                  | `localhost`              | Host in the URL                  |
| `PORT`                  | `3000`                   | Port in the URL                  |

A `HOST` of `0.0.0.0` is a bind address, not something a client can reach, so the
URL falls back to `localhost`.

These override the server URL stored in the global config, so pointing the agent at
another deployment does not require rewriting it. Precedence for `start`, most
specific first: `--server`, then `REMOTECODE_SERVER_URL`, then `HOST`/`PORT`, then
the stored config, then the URL baked in at publish time.

To make a change permanent instead:

```sh
remotecode setup --force --server http://127.0.0.1:3000
```

Read by the dev server (`dev:web`):

| Variable   | Default | Purpose                        |
| ---------- | ------- | ------------------------------ |
| `WEB_PORT` | `5173`  | Port Vite listens on           |
| `HOST`     | `127.0.0.1` | Proxy target host          |
| `PORT`     | `3000`  | Proxy target port              |

So a server on another port needs no file edits:

```sh
PORT=8080 pnpm --filter remotecode-server start
PORT=8080 pnpm exec remotecode setup --force
PORT=8080 pnpm --filter remotecode-server dev:web
```

## Docker

```sh
docker build -t remotecode .
docker run -d -p 3000:3000 -v remotecode-data:/data remotecode
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
pnpm --filter remotecode-server test:server  # node:test only
pnpm --filter remotecode-server test:web     # Vitest only
```

Tests import built output, since Node's type stripping does not rewrite the `.js`
specifiers the sources use, so `pnpm test` builds first.

Every test is isolated: its own temporary SQLite file, its own temporary `HOME`,
and a server on an ephemeral port. Engines are replaced by fake executables on
`PATH`, so no test calls a real AI provider or touches your global config.

Run the web app with hot reload against a running server:

```sh
pnpm --filter remotecode-server dev:web
```

After changing the database schema:

```sh
pnpm --filter remotecode-server db:generate
```

Migrations are additive only. See `RULES.md`.

## Releasing

Each app releases on its own tag, so shipping one does not ship the other.

| Tag                        | What it releases                 |
| -------------------------- | -------------------------------- |
| `remotecode-v0.2.0`        | the CLI, published to npm        |
| `remotecode-server-v0.2.0` | the server image, pushed to GHCR |

```sh
git tag remotecode-v0.2.0 && git push origin remotecode-v0.2.0
```

The version in the tag has to match `apps/remotecode/package.json`, or the
workflow fails before it builds anything. A `workflow_dispatch` run builds both
apps and publishes neither, which is how you check a release without cutting one.

The CLI is bundled into one file with esbuild. The four `@remotecode/*` workspace
packages are inlined, because `workspace:*` cannot be resolved from the registry
and would break `npm install` for everyone. Only `ws` and `qrcode` stay external.

```sh
pnpm --filter remotecode bundle   # writes apps/remotecode/bundle
```

The default server URL is baked in at bundle time from the
`REMOTECODE_DEFAULT_SERVER_URL` repository variable. A published CLI has no
repository to read, so the deployment it talks to has to be decided when the
artifact is built. It remains a default: a written config, `REMOTECODE_SERVER_URL`,
`HOST`/`PORT`, and `--server` all override it.

```sh
REMOTECODE_DEFAULT_SERVER_URL=https://rc.example.com pnpm --filter remotecode bundle
```

The server is released as a Docker image to GHCR. It is never published to npm.

Before publishing, the workflow installs the tarball outside the workspace and
runs the installed binary, which is the only way to catch a manifest that cannot
actually be installed.
