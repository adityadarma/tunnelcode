# TunnelCode

[![gh-workflow-image]][gh-workflow-url] [![npm-image]][npm-url] [![npm-downloads]][npm-downloads] ![][typescript-image] [![license-image]][license-url]


Run an AI coding agent on your own machine and drive it from a browser.

TunnelCode is a bridge between the browser, a server, and a local AI agent. It is
not an IDE and not an AI provider. See `PROJECT.md` for the full specification and
`DECISIONS.md` for the architecture decisions.

## Deploy the server

Docker Compose is how the server is meant to run. You do not need a checkout of this
repository: two files and a keypair are the whole of it.

All you need on the host is Docker with the Compose plugin. No Node, no pnpm.

**1. Fetch the two files** into an empty directory:

```sh
mkdir tunnelcode && cd tunnelcode
curl -fsSLO https://raw.githubusercontent.com/adityadarma/tunnelcode/master/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/adityadarma/tunnelcode/master/.env.example
```

**2. Create the network** the compose file joins. It is declared external so that a
reverse proxy living in its own compose project can reach this container by name.
Once per host:

```sh
docker network create internet
```

**3. Generate the push keypair.** The server prints instructions and exits without
one, so this is not optional:

```sh
docker run --rm --entrypoint node ghcr.io/adityadarma/tunnelcode:latest \
  -e "import('./dist/services/web-push.js').then(m => console.log(JSON.stringify(m.generateVapidKeys(), null, 2)))"
```

**4. Edit `.env`.** Two settings decide whether the container is reachable at all:

- **Set `HOST=0.0.0.0`.** The file ships `127.0.0.1`, which is right for a checkout
  and wrong in a container: `.env` overrides the image's own value, and loopback
  inside a container means the published port answers nothing. What controls access
  here is the port you publish and the firewall in front of it.
- **Paste both keys from step 3** into `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`.
  Keep the pair once notifications are in use: every subscription is bound to the
  public key it was created with, so replacing it silently retires all of them.

**5. Start it:**

```sh
docker compose up -d
docker compose ps
```

Wait for `healthy` rather than `Up`: the image carries a healthcheck against
`/api/health`, so that is the difference between answering and merely running.

The API and the web app are served from the same port, `3000` by default. Open it in
a browser, install the CLI below, and pair.

### Day to day

```sh
docker compose logs -f                        # follow the log
docker compose pull && docker compose up -d   # update to a new image
docker compose down                           # stop, keeping ./data
```

Updating asks nothing of anyone already paired. Connections drop and come back on
their own, and the sessions the CLI approved stay approved.

### What the compose file decides

| Setting                     | Why                                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `image: ghcr.io/…:latest`   | The published image. Pin a version tag instead if you would rather choose when to move.                                                        |
| `ports: '3000:3000'`        | The only way in. Publish to `127.0.0.1:3000:3000` when a proxy on the same host is the only thing that should reach it.                         |
| `volumes: ./data:/app/data` | Conversations and the session database, kept beside the compose file so a new image never touches them. `/app/data` is where the image looks.   |
| `restart: unless-stopped`   | Comes back after a reboot or a crash, and stays down when you stopped it on purpose.                                                           |
| `env_file: .env`            | Everything under Environment variables. These override the image's own values.                                                                 |
| `networks: internet`        | Shared with a reverse proxy that lives in another compose project.                                                                             |

The image is Alpine based, compiles the SQLite binding at build time, and runs as
`nobody`. The `./data` directory is created on first start and owned by that user.

### Behind a reverse proxy

Terminate TLS in front of the container and set `TRUST_PROXY`, so the pairing rate
limit counts real clients rather than counting the proxy as one. There is no user
authentication, so the proxy is also where anything deciding who may reach the app
belongs. See Security.

TLS is also what makes the browser offer to install the app and allow notifications;
neither is available over plain `http` except on `localhost`.

## Install the CLI

The CLI is published to npm as a single bundled file:

```sh
npm i -g tunnelcode
```

Then run it from the project directory you want the agent to work in:

```sh
tunnelcode
```

That opens a menu. Choose Setup on the first run to point it at your server, then
Scan QR to print a QR code and an 8 letter pairing code.

Needs Node.js 22.18 or newer. The minor matters: 22.18 is where Node runs TypeScript
without a flag and where `node:sqlite` exists, which is what reading an engine's own
session history needs.

It also needs an engine on PATH: [OpenCode](https://opencode.ai),
[Claude Code](https://claude.com/product/claude-code),
[Antigravity CLI](https://antigravity.google/product/antigravity-cli),
[Kiro CLI](https://kiro.dev), [Codex CLI](https://developers.openai.com/codex/cli),
[GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli), or
[Cursor Agent CLI](https://cursor.com/cli).

## Platforms

The CLI is developed and tested on macOS and Linux.

**Windows is untested.** The code is written for it — paths resolve from the home
directory the way Windows reports it, the config goes under `%APPDATA%`, a batch shim
is launched through `cmd.exe`, and file modes are skipped where the platform has none
— but none of that is verified by CI or by hand, so treat it as unsupported until
someone runs it. Reports are welcome.

The server does not need Windows. It ships only as a Docker image and runs on Linux,
so the browser is the only part of it you touch from any other platform.

## Pairing

1. Scan the QR or open the printed URL in a browser.
2. The browser shows a 4 digit approval number.
3. The terminal shows the same number. Press `y` to approve, `n` to reject.

The approval number never travels in a URL, so a leaked link is not enough to
pair. The pairing code is single use and only valid while the CLI is running.

A session ends after one hour without conversation, enforced by the server as well as
by the CLI exiting. `timeouts.idleMinutes` in `tunnelcode.json` can make the CLI end
an idle session sooner, but never later than the server's one-hour limit, so a
credential that leaked stops working rather than waiting for the next time the CLI runs
in that directory. A prompt, an answer, work the engine
did, or a permission answered all count as conversation; a browser being open does
not. A session also ends twelve hours after it was approved however busy it has been,
because the idle hour slides for whoever is using it.

Updating the server, or restarting it, asks nothing. Every connection drops and comes
back on its own, and the agent you already approved stays approved: it is the same run
of the CLI, and the sessions it approved say so. A prompt you have to answer after
every deploy is a prompt you stop reading.

Closing the terminal and starting it again keeps your conversation: the browser
reconnects on its own. It asks first. The terminal shows a number, the browser shows
the same one, and until you approve it that browser can read what was said but cannot
prompt or approve anything. Press `n` and its session is over, with the conversations
kept. A dropped connection that comes back does not ask, because that is the same
session, not a new one.

## CLI

`tunnelcode` takes no options that decide anything. Everything is chosen in the app,
so the server it answers to cannot be changed by a flag. See ADR-018 for why.
`-v`/`--version` and `-h`/`--help` only report and exit.

```
tunnelcode
  Scan QR    scan QR to pair
  Setup
  Exit
```

Setup holds Server URL, Device name, Engine, Never allow, Granted permissions,
Antigravity write access, and Check environment. The permission entries are explained
under Permissions.

Each field is written as soon as it is answered, so leaving the menu never
discards a change. Arrow keys and Enter move through the lists, Escape goes back.

## Engines

| Engine                                                             | Binary     | macOS | Linux            | Windows          |
| ------------------------------------------------------------------ | ---------- | ----- | ---------------- | ---------------- |
| [OpenCode](https://opencode.ai)                                    | `opencode` | ✅    | ✅ | ⚠️ needs a tester |
| [Claude Code](https://claude.com/product/claude-code)              | `claude`   | ✅    | ✅ | ⚠️ needs a tester |
| [Antigravity CLI](https://antigravity.google/product/antigravity-cli) | `agy`      | ✅    | ✅ | ⚠️ needs a tester |
| [Kiro CLI](https://kiro.dev)                                       | `kiro-cli` | ✅    | ✅ | ⚠️ needs a tester |
| [Codex CLI](https://developers.openai.com/codex/cli)               | `codex`    | ✅    | ✅ | ⚠️ needs a tester |
| [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) | `copilot`  | ✅    | ✅ | ⚠️ needs a tester |
| [Cursor Agent CLI](https://cursor.com/cli)                           | `agent`    | ✅    | ✅ | ⚠️ needs a tester |

✅ means the adapter has been driven against the real CLI on that platform, prompt to
answer, with its tool calls reported and an earlier conversation continued. ⚠️ means
nobody has done that yet — not that it is known to fail. The adapters are written for
all three: the lookup goes through the platform's own tool, a batch shim is launched
through `cmd.exe`, and nothing depends on a shell. Reports are welcome.

Permission asks are covered by the test suite for every engine that raises them, on
whatever platform the suite runs. The table is about the real binaries.

That is a narrower claim than the one under Platforms, which is about the CLI itself.
An engine adapter talks to somebody else's binary, so it can break on a platform the
CLI is fine on.

The CLI offers every engine that is both supported here and installed on your
machine. Nothing else is offered, so a choice made in the browser can always be
served. If no engine is installed, the session does not start.

The engine is chosen in the browser, once per conversation, when the conversation is
created. It cannot be changed afterwards: the agent's memory of what was said lives
in an engine session, and moving a conversation to another engine would abandon it
without saying so. Start a new conversation to use a different engine.

The model can be changed at any time, as long as it belongs to that conversation's
engine.

The Engine entry in Setup names what a new conversation starts on. A configured
engine that is not installed is skipped in favour of one that is. See ADR-020.

### How engines and models are named

Engines and models are shown under the names their vendors use, and stored under the
values their binaries accept. The two are rarely the same string, which is why they are
kept apart: Cursor answers to `default[]` for the model it calls Auto, and to
`claude-opus-5[thinking=true,context=300k,effort=high,fast=false]` for the one it calls
claude-opus-5. Shortening either would be asking for a model the engine does not have.

So the picker reads `Claude Sonnet 5` where Copilot's id is `claude-sonnet-5`,
`GPT-5.6-Terra` where Codex's is `gpt-5.6-terra`, and `Gemini 3.6 Flash (High)` where
Antigravity's is `gemini-3.6-flash-high`. Searching matches the id as well as the name,
so a model can still be found by a parameter that is never on screen.

Kiro CLI and Claude Code report no names — Kiro's own picker shows its ids too — so
theirs are shown as they are. Nothing is invented to fill the gap: a name guessed from
an id gets `Gpt 5.6 Sol` for a model everyone else calls GPT, and a wrong name is worse
than a plain one. See ADR-051.

## Stopping an answer

While an answer is running, the send button is a **Stop** button. Pressing it kills
the engine process on the paired machine and ends the turn, including a turn that has
stopped saying anything at all, which is the one worth stopping. The machine is only
told to kill the process after the turn has already been ended, so a stop never waits
on the thing that is stuck.

What the agent had already said, and the work it had already done, are kept. The
transcript marks it as an answer you stopped rather than one that failed, so coming
back to it later says what happened.

## Permissions

The agent asks before it does something it will not do on its own. A tool call that
needs approval appears in the browser above the composer, and the turn stops there
until it is answered:

- **Allow once** runs this call and nothing else.
- **Always allow** runs it and records a rule, so calls like it are not asked about
  again on this machine.
- **Deny** refuses the call. The turn carries on and the answer explains what it
  could not do.

The card lists every operation the request covers, not only the first: one request
from opencode can carry several commands, and agreeing to one of them would mean
agreeing to all. A request nobody answers within 5 minutes by default is refused,
never allowed, and a phone that locks mid-turn is shown the request again when it
comes back. `timeouts.answerMinutes` in `tunnelcode.json` can change that approval
deadline for the paired machine.

A recorded rule answers for a command line only when it accounts for the whole of
it. A line that runs a second command is asked about again even when the first one
matches, and so is a line where a shell character merely could run one — a `&`
inside a quoted URL, say. Reading that difference correctly would need a shell
parser, and one that is wrong once is a hole rather than a nuisance.

Always allow is recorded for the machine, not for the engine and not on the server.
The rules live in `permissions.json` next to the config, owner-readable only, and
they are withdrawn from the terminal rather than from the browser:

- **Setup → Granted permissions** lists what was granted from a phone and can clear
  it.
- **Setup → Never allow** names rules this machine will never agree to, whatever the
  browser answers. Written as `Bash` for a whole tool or `Bash(rm *)` for a pattern.
  A request it matches is refused where it is raised and never sent to the browser.
  For Antigravity, which raises no request, it is checked when a grant is written
  instead, so the entry still holds.

Never allow is a filter on what may be allowed, not a sandbox. It can only recognise
what its patterns describe, and an engine that decides a call is safe on its own,
such as Claude Code with a read-only shell command, never asks and so never reaches
it. Judge a grant by what it would allow next time, not only by the call in front of
you.

### Cursor is asked over a subcommand it does not advertise

Cursor does show cards. It is driven through `agent acp`, which starts an Agent Client
Protocol server, because every surface Cursor documents decides tool calls from its own
allowlist: `agent -p` leaves the call waiting with nothing able to answer, and
`--force` runs everything without asking. Over ACP the ask reaches the browser like any
other.

That subcommand is hidden. It is in no `--help` output and no published reference, so a
Cursor release could rename it. A test pins the argument, and if it ever goes the
session fails at startup saying so rather than quietly running calls nobody approved.

Always allow is recorded on this machine as it is for the other engines, not through
Cursor's own allowlist, so Setup can list it and clear it. A conversation is answered
in Cursor's agent mode, set here rather than read from your own Cursor settings, since
its plan and ask modes cannot touch the workspace at all.

A Cursor conversation reports no token usage. Nothing on that surface carries a count,
so none is shown rather than a zero that would read as free.

### Antigravity is different

Antigravity never shows a card. Its headless mode has no prompt of its own, so there
is no channel to carry a question out and an answer back, and a call it will not make
alone is refused rather than asked about. A conversation on it shows blocked calls
where the other two would have asked.

What it may do is therefore decided before the turn starts:

- Reading the workspace works with no setup.
- Writing needs **Setup → Antigravity write access**, which adds one
  `write_file(<workspace>)` rule to Antigravity's own settings for the workspace you
  are in. The same entry withdraws it. Without it the engine can study a project but
  never change it.
- Running commands needs **Setup → Antigravity command access**, which adds one
  `command(*)` rule. That rule covers every command and is not scoped to the
  workspace. It is asked for on its own, never bundled with write access, and the
  same entry withdraws it.

Never allow reaches both of these, even though Antigravity raises no ask for it to
refuse. It is checked when the grant is written rather than when a call is made, so a
rule it forbids is never added and the entry that forbade it is named. Because a grant
is a rule and not a single call, the check runs both ways: `Never allow` set to
`command(rm *)` is enough to refuse `command(*)`, which would have covered it.

Write access is the only one of the two the browser can grant. A blocked write shows
a **Grant write access & Retry** button, which adds the `write_file(<workspace>)`
rule and re-sends the prompt. There is no such button for `command(*)`: it is
unscoped and no ask can be raised about it later, so the choice stays in Setup where
the person making it is at the terminal reading what it covers.

That rule lives in `~/.gemini/antigravity-cli/settings.json`, which belongs to `agy`
and is read every time it runs, so granting it affects your own terminal sessions too.
That is why it is a menu item you choose rather than something done for you. Nothing
else in that file is touched, and settings that cannot be parsed are refused rather
than overwritten. See ADR-031.

### Codex asks from inside a sandbox

Codex does show cards, and it decides when to raise one from a sandbox rather than
per tool call. TunnelCode starts every Codex thread read-only, so the engine reads the
workspace and runs commands that only read without asking, and everything that writes
a file or reaches the network becomes an ask.

Those two settings are set here, on every thread, and not read from your
`~/.codex/config.toml`. An `approval_policy` of `never` in that file would otherwise
let the engine decide every call by itself, and a `danger-full-access` sandbox would
let it do anything, neither of which the phone holding the session could see. What is
in your config file still applies to your own `codex` sessions. See ADR-048.

Always allow is recorded on this machine as it is for the other engines, not with
Codex's own `acceptForSession` or its execpolicy rules, so Setup can list it and clear
it.

## Install it as an app

The web app is installable. Chrome and Edge offer an install button in the address
bar; on iOS use Share, then Add to Home Screen. Installed, it opens in its own window
without browser chrome and starts from the conversation it was last on.

Installing needs a secure context, which means `https` or `localhost`. Reached over
plain `http` on a LAN address the app still works, but the browser will not install it
and will not allow notifications.

## Notifications

Press **Notify me** in the sidebar to be told when the agent needs you. Two things are
worth an interruption, and those are the only two that raise one:

- **An approval is waiting.** The agent has stopped and will not go on until it is
  allowed to, and the ask expires on its own.
- **The answer is ready**, including when the turn failed.

Notifications are only raised when you are not already looking. A tab in the
background gets one from the page. With nothing open at all, the server sends a push
and the service worker shows it, so an approval reaches you with the browser closed.
A visible tab gets none: the card is already on screen.

The payload is encrypted for your browser alone, so the push service in between
carries something it cannot read. Notifications stop when the pairing ends, and the
subscription is dropped with it.

On iOS this only works once the app has been added to the home screen: Safari does not
offer notifications to a tab. See ADR-045.

## Configuration

Configuration is per user. There is one file:

- macOS and Linux: `~/.config/tunnelcode/tunnelcode.json`
- Windows: `%APPDATA%/TunnelCode/tunnelcode.json` (untested, see Platforms)

```json
{
  "server": { "url": "https://server.example.com" },
  "device": { "name": "MacBook Pro" },
  "engine": "opencode"
}
```

Two more files sit beside it, both written owner-readable only: `permissions.json`
for what was granted from a browser, and `machine-id`, from which every device id on
this machine is derived.

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

| Variable             | Default                  | Purpose                                   |
| -------------------- | ------------------------ | ----------------------------------------- |
| `VAPID_PUBLIC_KEY`   | none, required           | Push signing identity                     |
| `VAPID_PRIVATE_KEY`  | none, required           | Push signing identity                     |
| `HOST`               | `0.0.0.0`                | Bind address                              |
| `PORT`               | `3000`                   | Port for HTTP and WebSocket               |
| `DATABASE_FILE`      | `data/tunnelcode.sqlite` | SQLite location                           |
| `LOG_LEVEL`          | `info`                   | `fatal` through `trace`, `silent`         |
| `ENV_FILE`           | nearest `.env`           | Environment file to load                  |
| `TRUST_PROXY`        | unset                    | Whose forwarded client address to believe |

The two VAPID keys are the only required ones: the server prints how to generate a
pair and exits when either is missing. `.env.example` ships them empty for that
reason. Keep the pair stable once notifications are in use, because every
subscription is bound to the public key it was created with.

`HOST` defaults to every interface, which is what a container wants. A checkout
usually wants the opposite, and `.env.example` ships `127.0.0.1` to get it: exposing
the server exposes an agent that can read and write files on the paired machine, so
outside a container it should be a deliberate choice. Read Security before widening
it.

`TRUST_PROXY` matters when the server sits behind a reverse proxy. Unset, the
connection's own address is the only one trusted, and `X-Forwarded-For` is ignored:
the server can be reached directly, and then that header is only what the client
wrote, which would let one client look like a new one on every request and stop the
pairing rate limit from counting. Set it to `true` when nothing but the proxy can
reach the port, or name the proxy addresses to trust. Leaving it unset behind a proxy
is safe but blunt: every client shares the proxy's address, so one of them can
exhaust the limit for all of them.

The CLI decides which server to talk to from the stored config alone. Precedence,
most specific first: the stored config, then the URL baked in at publish time,
then `http://localhost:3000`. Change it in Setup, Server URL.

Read by the dev server (`dev:web`):

| Variable   | Default | Purpose                        |
| ---------- | ------- | ------------------------------ |
| `HOST`     | `127.0.0.1` | Proxy target host          |
| `PORT`     | `3000`  | Proxy target port              |

So a server on another port needs no file edits:

```sh
PORT=8080 pnpm --filter tunnelcode-server start
PORT=8080 pnpm --filter tunnelcode-server dev:web
```

The CLI is not in that list: point it at the new port in Setup, Server URL.

## Security

**There is no user authentication.** Anyone who can reach the server and complete
pairing controls an agent that can read and write files on the paired machine. Deploy
it behind TLS, and decide who can reach the port before you expose it.

What the server enforces, so it is clear what is and is not being relied on:

- **Pairing** needs a 4 digit number approved in the terminal. It never travels in a
  URL, the code is single use, and the endpoint is rate limited.
- **Sessions expire** an hour after the conversation went quiet, and twelve hours
  after approval regardless. A restart extends neither.
- **The credential** is a token in an `HttpOnly`, `SameSite=Strict` cookie, stored
  only as its SHA-256. The page cannot read it. The session id it does keep opens
  nothing on its own, and neither does a conversation id.
- **A restarted CLI** must be approved again before that session can prompt or
  approve anything; reading the transcript is not gated, since reading does nothing
  to the machine. A restarted server asks nothing, because approval is tied to an id
  the CLI generates per process and no browser can send.
- **Origin is checked** before the WebSocket upgrade, since WebSocket ignores CORS,
  and no page may frame the app — inside a frame the origin check cannot help, and a
  click laid over the approval card would be answered by the paired machine.
- **Secrets stay out of logs**: no pairing code, session id, or token. Oversized
  frames are refused by the transport rather than parsed.
- **Local files** — config, granted permissions, machine id — are `0600` in a `0700`
  directory.

Permission prompts control what the agent does with your files; they are not a
boundary around it. See Permissions and ADR-022.

## Development

Everything below is for working on TunnelCode itself. Deploying it needs none of it.

Needs Node.js 22.18 or newer and pnpm 11. From a checkout:

```sh
pnpm install
pnpm build
```

```sh
pnpm build        # build every package
pnpm typecheck    # type check, including the web app
pnpm lint         # ESLint
pnpm format       # Prettier
pnpm test         # build, then run every test
```

### Running the server from a checkout

```sh
pnpm --filter tunnelcode-server start
```

It reads the same `.env` and serves the web app from the same port as the image. Note
that `.env.example` ships `HOST=127.0.0.1`, which is what you want here: nothing
restarts this if it stops, and it is not meant to be reachable from elsewhere.

Push keys are required here too, so generate a pair before the first start:

```sh
node -e "import('./apps/server/dist/services/web-push.js').then(m => console.log(JSON.stringify(m.generateVapidKeys(), null, 2)))"
```

### Building the image yourself

Only needed to run an unreleased change; the compose file pulls a published image.

```sh
docker build -t tunnelcode .
```

Then point `image:` at `tunnelcode` in a compose override file.

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

The version in the tag has to match both `apps/cli/package.json` and
`apps/server/package.json`, or the workflow fails before it builds
anything. Bump the two together. A `workflow_dispatch` run builds both apps and
publishes neither, which is how you check a release without cutting one.

The image is pushed before the CLI is published, because a GHCR tag can be
overwritten while an npm version cannot be republished. If the image build fails,
nothing reaches npm.

The CLI is bundled into one file with esbuild. The four `@tunnelcode/*` workspace
packages are inlined, because `workspace:*` cannot be resolved from the registry
and would break `npm install` for everyone. Only `ws` and `qrcode` stay external.

```sh
pnpm --filter tunnelcode bundle   # writes apps/cli/bundle
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

The release workflow runs no checks of its own. It verifies the tag, builds, bundles,
and publishes. Everything that can say no lives in CI, and the release refuses to
publish a commit with no passing CI run for that exact commit. A tag can point at
anything, including a commit nothing ever tested, and an npm version cannot be
republished once it is out. A CI run still in progress is waited for rather than
treated as a failure, since tagging straight after a commit is the normal case.

CI is what installs the tarball outside the workspace and runs the installed binary,
which is the only way to catch a manifest that cannot actually be installed. It
asserts on behaviour rather than on anything printed: the binary has to report the
version baked into it at bundle time and the menu has to open and exit cleanly.
Asserting on a menu label is what broke a release once, when the label was renamed.

## License

This package is open-sourced software licensed under the [MIT license](LICENSE.md).

[gh-workflow-image]: https://img.shields.io/github/actions/workflow/status/adityadarma/tunnelcode/release.yml?style=for-the-badge
[gh-workflow-url]: https://github.com/adityadarma/tunnelcode/actions/workflows/release.yml 'Github action'
[npm-image]: https://img.shields.io/npm/v/tunnelcode/latest.svg?style=for-the-badge&logo=npm
[npm-url]: https://www.npmjs.com/package/tunnelcode/v/latest 'npm'
[typescript-image]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[license-url]: LICENSE.md
[license-image]: https://img.shields.io/github/license/adityadarma/tunnelcode?style=for-the-badge
[npm-downloads]: https://img.shields.io/npm/dm/tunnelcode.svg?style=for-the-badge
[count-downloads]: https://npmcharts.com/compare/tunnelcode?minimal=true