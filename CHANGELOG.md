# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The CLI and the server image share one version and ship from a single `v*` tag.
Every change is written under `Unreleased` as it is made; a release renames that section
to the version it ships as and leaves an empty one behind.

## [Unreleased]

### Security

- A session now also expires twelve hours after it was approved, however busy it has
  been. The hour of idleness stays, and a session ends at whichever comes first. The
  idle hour slides forward on every prompt and every answer, including ones sent by
  somebody the session does not belong to, so a credential that had been copied only
  had to be used once an hour to last forever. Reaching the ceiling means scanning the
  QR again; the conversations are kept. See ADR-039.
- Restarting the terminal now asks before handing the machine back. A browser paired
  before the restart reconnects as it did, but the terminal shows a number, the
  browser shows the same one, and until it is approved that browser can read the
  transcript and cannot prompt or answer a permission ask. Pressing `n` ends its
  session and keeps the conversations. Stopping the agent is the one thing a user
  would call "closing it", and it used to revoke nothing: the session outlives the
  process on purpose, so the first browser to come back got the agent, whoever was
  holding it. A dropped connection that comes back is not a restart and asks nothing,
  so a flaky network still costs no keypresses. See ADR-040.
- The session credential is now a token in an `HttpOnly`, `SameSite=Strict` cookie,
  and the server stores only its SHA-256. It used to be the session id, kept in local
  storage and sent in paths and in a header, which meant a script that reached the
  page could copy it and drive the agent from anywhere, and a proxy in front of the
  server could log it. The id is still what the page remembers and what paths carry,
  and it now opens nothing on its own. `Secure` is set when the request arrived over
  TLS, and left off otherwise so a plain address on a home network still works. Pair
  again after upgrading: a session approved by the previous version has no token.
  See ADR-041.

### Added

- The line under a running turn now says what it is doing: reading, writing, editing,
  running, searching, fetching, answering, or thinking. It used to say `thinking…`
  throughout, so a minute spent on a build or on a search read as a model sitting
  still, which is the one thing it was not doing. A call that has finished and a
  paragraph already written hand the line back to thinking, so it never claims to be
  reading a file it read a minute ago. The verb is taken from the tool's own name, so
  an engine this project has never seen still reports something useful. See ADR-038.
- A turn now shows what the model was working out, folded above the answer it led to.
  It says `Thinking…` while the thought arrives and `Thought` once it is done, and it
  opens on a tap. Until now the deliberation was thrown away, so a model that spent a
  minute reasoning looked stalled, and a wrong answer gave no clue where it went
  wrong. It is kept apart from the reply at every step, so the answer never carries
  it, and it comes back with the rest of the transcript after a refresh. Closed by
  default, because the working should be available rather than in the way. opencode,
  Claude Code and Kiro report their thinking; Antigravity reports none, so nothing
  changes there. See ADR-037.
- Antigravity can be allowed to run commands, from Setup under Antigravity access. It
  is a grant of its own, separate from write access, and withdrawn from the same place.
  Until now a build or a test it wanted to run was always refused mid-turn, where
  nobody could answer, so it could not check what it had just written. The rule covers
  every command, because Antigravity matches a command rule as a prefix of the whole
  command line and the agent puts its own `cd <workspace> &&` in front of the program
  it means to run. The menu says that, and that `Never allow` cannot hold it back,
  before the choice is made. See ADR-035.

### Fixed

- The prompt box no longer disappears under the keyboard on a conversation with nothing
  in it yet. The welcome screen held a minimum height, so the message area could not
  give way when the keyboard opened and the composer was pushed out of the column,
  which clips. A conversation already underway was never affected because it scrolls.
  On a short viewport the welcome decoration is dropped rather than cropped.

### Changed

- On a touch screen, Enter in the prompt box adds a line and only Send sends. An
  on-screen keyboard has no Shift+Enter, so a prompt used to be sent half-written the
  moment it was paragraphed. With a physical keyboard Enter still sends. Enter that
  confirms a predictive keyboard's suggestion never sends either. See ADR-036.
- Expanding an opencode `read` now starts at the file. The tool answers inside an
  envelope naming the absolute path and the type, which was three lines of scrolling
  repeating the target already shown above it, and a reminder addressed to the model
  after the last line. The numbered lines and the note saying where the read stopped
  are kept, and an output that does not match that shape is still shown exactly as it
  came.
- Expanded tool output no longer glues a separator to its line numbers. A file read
  arrived as `12: code` and a `grep -n` as `12:code` or `13-code`, so every line of
  code carried a colon or a dash that was not in the file, in front of code that is
  already full of both. The number stays and the separator becomes a space, with the
  line's own indentation untouched. Only lines that count up one at a time are read as
  numbering, so a dated log keeps its dates.
- The transcript no longer jumps to the bottom every time something arrives. Reading
  back through an answer, or through the output of a call, used to be interrupted by
  each new paragraph or tool result dragging the view down. The view now stays where it
  was put and scrolling is left to the reader.
- An answered menu clears itself from the screen, so choosing Setup no longer leaves
  the main menu above it and a few choices no longer fill the terminal. What an action
  printed stays.
- A refused Antigravity command now names `command(*)` and points at Setup, rather than
  a rule shaped like the one command that happened to be refused, which would not have
  matched the next one.
- The Setup item is now `Antigravity access`, showing both what it may write and
  whether it may run commands.

## [0.3.6] - 2026-08-02

A fourth engine, and an answer that survives leaving the page. Kiro CLI can now answer a
conversation, and it is the third engine that can be asked before it acts: a shell
command it will not run alone reaches the browser as an Allow or Deny, like Claude Code
and opencode. Offered in Setup and in the browser only when `kiro-cli` is installed.

A browser that comes back mid-answer is given the text so far instead of a blank
indicator, and a turn that never finished says so in the transcript rather than leaving a
prompt with nothing after it.

### Added

- Kiro CLI adapter, driven as `kiro-cli acp`, which speaks the Agent Client Protocol
  over stdio. Text streams as it is written, tool calls are reported with their output,
  and the session id is reported so a later prompt continues the same conversation.
  `--trust-all-tools` is never passed, so nothing is approved on the agent's behalf.
  See ADR-034.
- A permission ask reaches the browser and the answer returns to the turn waiting on
  it. The call is named as Kiro names it, `shell` or `write` rather than the protocol's
  coarser `execute` or `edit`, so a rule granted for one command does not quietly cover
  a whole category. What the call would do is taken from the update that announced it,
  because the ask itself carries only a tool call id and a title.
- The model chosen in the browser is applied to the session on every turn, so changing
  it mid-conversation takes effect. A model Kiro will not take is said as a log and the
  turn still answers on the default.
- A browser that attaches mid-turn is given the answer so far. The text being streamed is
  kept in memory beside the running turn and sent with the attach, so coming back to a
  long answer no longer shows minutes of a blank indicator. It is dropped the moment that
  text becomes a stored message, so nothing appears twice. See ADR-032.
- A turn that ends without a complete answer stores what the engine had already produced,
  marked partial, and is stored even when nothing was said. A device that went offline
  mid-answer used to leave a prompt with nothing after it, which reads as a prompt that
  was never sent. See ADR-033.

### Changed

- The engine belongs to the conversation in the browser too. The device card no longer
  states an engine, since each conversation row already names its own, and the New
  Conversation dialog opens on the engine this machine runs by default. See ADR-020.
- Activity output scrolls sideways rather than wrapping, the way a fenced code block
  already does. Read output carries a line number in front of every line, and a wrapped
  line read as a line with no number: the numbers stopped matching the file and
  indentation stopped meaning anything. A sideways drag stays inside the panel.
- The GitHub Actions used by CI and release are on their current major versions.

### Fixed

- Starting the CLI no longer opens a Kiro login page. Listing Kiro's models does not
  fail when nobody is logged in: it opens a browser, starts a device login and waits.
  That ran during engine discovery at every startup. The login is now checked first
  with `kiro-cli user whoami`, which answers instead of trying to fix it, and a machine
  with no Kiro login simply offers its other engines. See ADR-034.
- A Kiro failure is reported in its own words. Every error carrying JSON-RPC's
  implementation-defined `-32000` was read as a missing login, so a quota problem
  answered with "run kiro-cli login", which cannot fix it.
- A Kiro conversation keeps its context. Continuing one used a resume method kiro-cli
  does not implement, so every prompt quietly started over. It now loads the session,
  and the transcript the load replays is not repeated into the new answer.
- Kiro's model list is no longer empty. The ids were read from fields the listing does
  not use, and the plain listing dropped `auto`, which is the default.
- A refused Kiro tool call is explained once. The engine fails the call with a notice
  wording it as the user having denied it, which was relayed on top of the reason this
  machine actually had, and sometimes nobody had been asked at all.
- opencode's thinking is no longer read as its answer. A reasoning part streams through
  the same event as text and names its own field `text` as well, so the model working
  itself out was shown run together with the reply that followed. Recognised by part id,
  which is announced before any of its fragments arrive.
- Dismissing the sidebar no longer collapses two of them. Below md it is a drawer over the
  conversation and from md up a column beside it, and one tap closed both, which is why an
  extra Show sidebar icon appeared in the header after closing the drawer with the button
  but not after tapping the overlay.

### Security

- A recorded rule answers for a command line only when it accounts for the whole of it.
  `&` on its own was not read as a separator, so a grant written for curl covered
  `curl example.com & rm -rf ~` in full, and a ceiling written for `rm *` did not
  recognise it at all. `>(...)` is now read as a hidden command like `<(...)`, and the
  ceiling looks inside a nested command so the `rm` in `echo hi > >(rm -rf ~)` can be
  forbidden.
- No page may put this app in a frame. Every response carries a content security policy
  with `frame-ancestors 'none'`, whose only inline script is allowed by a hash derived
  from the document actually served, plus HSTS for a year without `includeSubDomains`.
  Refusing a WebSocket handshake by origin cannot help inside a frame: the page is this
  server's own origin, so a click laid over the approval card would be answered by the
  paired machine.
- Neither a pairing code nor a session id is written to the log. The code arrives in the
  query string of the QR link and the session id as a path segment, so redacting field
  names never reached either of them. The shape of the route and the names of the query
  parameters are kept, and the values are not. See ADR-014.

## [0.3.5] - 2026-08-02

A third engine. Antigravity CLI can now answer a conversation, alongside OpenCode and
Claude Code. It is offered in Setup and in the browser exactly like the other two,
and only when `agy` is installed.

### Added

- Antigravity CLI adapter, driven headlessly as
  `agy -p <prompt> --output-format stream-json --add-dir <workspace>`. Text, tool
  calls with their output, and the conversation id are read from the NDJSON event
  stream, so a reply streams as it is written and a later prompt continues the same
  conversation through `--conversation`.
- Setup gains **Antigravity write access**, which lets Antigravity change files in the
  current workspace. Headless mode cannot ask about a write, so without this the engine
  can read a project but never edit it. Granting adds a single
  `write_file(<workspace>)` rule to Antigravity's own settings, and the same menu
  withdraws it.

  Offered rather than done automatically, because that file belongs to `agy` and is read
  every time `agy` runs, so the grant applies to your own terminal sessions too. It
  names one workspace rather than every path, and running commands stays refused, so an
  engine that cannot be asked still cannot run anything. Nothing else in the file is
  touched: unknown fields are kept, `deny` and `ask` are left alone, the file mode is
  preserved, and settings that cannot be parsed are refused rather than overwritten.
  See ADR-031.
- The workspace is named with `--add-dir` rather than only entered. Antigravity keeps
  its own idea of a workspace and falls back to a scratch directory under `~/.gemini`
  when nothing is added, so without it the agent answers that no project is open while
  the process is sitting in one. See ADR-031.
- Models come from `agy models` and are offered by slug. Headless mode refuses an
  unknown `--model` instead of falling back, so the display name would fail the run.
- A conversation whose id Antigravity no longer knows is answered without the earlier
  context rather than failing, which is how the other two adapters already behave.

### Security

- A conversation id alone no longer lets a session prompt into it. `prompt` on the
  browser socket now checks that the conversation belongs to the caller, the same way
  the HTTP routes already did. Without it a session could send work to a conversation
  on another machine, which means running an agent against a workspace it was never
  paired with. A refusal reads as "unknown conversation" either way, so the reply says
  nothing about whether it exists elsewhere.
- A socket that never identifies itself is closed after 15 seconds. Until a CLI
  registers or a browser attaches, a connection has proved nothing, and nothing ended
  those: an unauthenticated socket could hold a slot and a heartbeat until the server
  restarted, so opening many of them spent the server's resources without completing a
  single pairing. The timer is unreferenced, so a socket that connects during a drain
  cannot delay shutdown.

- `--dangerously-skip-permissions` is never passed to `agy`. It approves every tool
  call, file writes and shell commands included, which would put an engine chosen in a
  browser outside the ceiling this machine sets for the other two: Never allow cannot
  filter what it never sees. Left off, Antigravity applies its own policy and
  soft-denies what it cannot approve, and the adapter reports that as a blocked call.
  Pinned by a test, so removing the omission fails loudly. See ADR-031.
- A refused call is reported once, and in this project's words. Antigravity words the
  refusal as the user denying permission, for a call no user was ever shown: nothing
  was asked, because headless mode has no prompt. Its own wording is still kept as the
  output of the call, so nothing it said is hidden.

### Changed

- The README now states which platforms this is actually tested on: macOS and Linux.
  Windows is written for but unverified, and is documented as unsupported until someone
  runs it rather than left to be assumed. The server never needed Windows, since it
  ships only as a Docker image.
- Test helpers no longer assume POSIX. The home directory is isolated through
  `USERPROFILE` as well as `HOME`, a stored config is looked for where the platform
  actually puts it, `PATH` is joined with the platform separator, and a fake engine is
  installed as a `.cmd` shim where a shebang means nothing. None of this is verified by
  CI, but a test that would have written into a real home directory is a bug whether or
  not it is ever run there.
- The release workflow runs no checks. Tests and the tarball verification moved to CI,
  so a tag builds, bundles and publishes and nothing else. In exchange it refuses to
  publish a commit that has no passing CI run of its own, because a tag can point at a
  commit nothing ever tested and an npm version cannot be republished. A run still in
  progress is waited for, since tagging right after a commit is the normal case.
- The tarball smoke test asserts on behaviour rather than on menu text: the installed
  binary has to report the version baked in at bundle time, and the menu has to open and
  exit cleanly. The previous check asserted a menu label, which failed the 0.3.4 release
  when that label was renamed rather than catching anything real.

### Migration

Nothing to do. Antigravity is only offered where `agy` is installed, and an engine
that is absent is not shown, so an existing machine behaves exactly as it did.

- An Antigravity conversation shows no Allow or Deny card, because headless mode has
  no interactive prompt to carry the question. What it may do is granted ahead of time
  in `permissions.allow` in `~/.gemini/antigravity-cli/settings.json`, not from a
  phone. The other two engines are unchanged. See ADR-031.
- `agy` has to be authenticated once interactively before a headless run works. An
  unauthenticated one exits with an authentication error rather than hanging.

## [0.3.4] - 2026-08-01

### Changed

- The main menu item "Continue" is renamed to "Scan QR" for clarity.
- Running `tunnelcode` no longer prints the name and version header before the menu.
  The menu appears immediately.
- The typing indicator now reads "thinking…" instead of "typing…".
- The model picker is now searchable: type to filter models when the dropdown is open.
- The sidebar gains a toggle button to collapse and expand it.
- The model picker disabled state is visually distinct from the enabled state.
- Node.js upgraded from 22 to 24 in the Docker image and CI workflows.

### Added

- `-v` / `--version` flag prints the version number and exits.
- `-h` / `--help` flag prints usage information and exits.
- The app version is displayed in the web UI.

## [0.3.2] - 2026-07-31

The agent now asks before it does something it will not do on its own, and the answer
comes from the phone. Until now a tool call that needed approval was simply refused,
because nobody could be asked: the turn carried on and the reply explained what it
could not do. A refusal is now a question.

Asking made the rest of the release necessary. An answer that can allow a command has
to be judged against the whole command, a session id that can carry that answer cannot
be valid forever, and a socket that can deliver it cannot be opened by any page the
user happens to visit. The Security section is the longest part of this release and
closes holes that are open in 0.3.1; read Migration before upgrading, because a
deployment behind a reverse proxy now has to say so.

A turn that fans out into subagents also works now, and says what it is doing while it
does it.

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

- A turn that spawns opencode subagents no longer stalls until it is abandoned. A `task`
  runs in a session of its own, and the permission request its first shell command
  raised was dropped as another conversation's business, so the subagent waited for an
  answer nobody was ever shown. The turn produced nothing and was cancelled five
  minutes later as a hung engine. Sessions started under this turn now belong to it.
- What a subagent is doing is now visible. Its tool calls appear as activities of the
  turn that started it, instead of a lone `task` line that sat there for minutes with
  nothing under it. Its own narration stays out of the answer, which is the parent's to
  give.
- A subagent finishing no longer ends the turn, and a subagent failing no longer fails
  it. Both are its parent's to report.
- A tool call whose only readable argument is a description now shows it, so a subagent
  says what it was sent to do rather than showing as a bare tool name.
- What a tool acted on is no longer cut off at 120 characters with an ellipsis. A chained
  shell command ends in the part that matters, so the cut hid exactly what the reader
  was looking for; the pill scrolls instead. It also fixes what a lasting grant records,
  since a rule was being judged against a command that had lost its tail.
- A workspace path in a target is dropped rather than replaced with `./`. `Read` on
  `/home/me/project/src/a.ts` now reads `src/a.ts`. Every path in a transcript starts at
  the workspace, so the marker was as much to read as the folder name behind it. The
  workspace on its own is still a dot, because nothing is left of it to name.

### Security

**What a granted rule covers**

- A grant made for one command no longer widens into a grant for the tool. A request
  that reported nothing about what it would do was treated as covered by any rule for
  that tool, so one tap meant for `Bash(curl *)` allowed every later Bash request that
  named no target.
- A grant no longer carries a second command along. `Bash(curl *)` matched
  `curl example.com; rm -rf ~` as a single line, so the rm ran without being asked
  about. Every command in a line must now be covered, and a line containing `$( )`,
  backticks, or `<( )` is never covered, because there is no honest way to read what
  it would run.
- Never allow now looks inside a chained line as well as at it, so `Bash(rm *)`
  catches `echo hi; rm -rf ~`. Missing it there was worse than missing it on a grant,
  since this is the limit that is supposed to win.

**Who may reach a conversation**

- A conversation id on its own no longer opens a transcript. `GET`, `PATCH`, and
  `DELETE` on a conversation now require the session in an `x-tunnelcode-session`
  header, and the conversation has to belong to it. A transcript carries the output of
  every tool the agent ran, which is file contents and command results from the
  machine. Entitlement is the workspace rather than the session row, so pairing again
  still reopens the same history.
- A session ended from the browser can no longer be used. `endedAt` was written and
  never read, so the same id could attach again afterwards and still answer a
  permission request on the machine. It is now absent everywhere a session is looked
  up, including over HTTP.
- A session now expires on the server after an hour without conversation activity.
  The hour existed only in the CLI, where it ends the process, and the id is not held
  by the process: the timestamp meant for this was never read, so a session id was
  accepted forever. The device id is derived from the machine and the workspace, so a
  leaked id kept matching every time the CLI was started in that directory again, and
  a session that was logically dead could send prompts to the agent. Activity is a
  prompt, an answer, engine work, or an ask being decided; a heartbeat, a browser
  attaching, and individual deltas are not. It is stored on the session row, so a
  restart does not hand a stale id another hour.

**What may reach the server**

- A WebSocket handshake carrying an `Origin` that is not a host the request was
  addressed to is refused, before the upgrade, on both sockets. WebSocket is not
  subject to CORS, so any page the user visited could open a socket to the agent and
  start sending. Attaching still needed a session id it could not read, but this is
  what stops it trying at all, and what stands in the way of the same trick through a
  rebound DNS name. A handshake with no `Origin` is still accepted, which is what the
  CLI sends.
- Forwarded client addresses are no longer trusted by default. `trustProxy` was on
  unconditionally so the rate limit could tell clients apart behind a proxy, but the
  server can be reached directly, and then `X-Forwarded-For` is a string the client
  writes: a new value per request was a new identity, and the limit of 10 pairing
  attempts a minute stopped counting. Set `TRUST_PROXY=true` behind a proxy, or name
  the proxy addresses to trust.
- Messages now have a maximum length, and a frame larger than the longest legal
  message is refused by the transport before it is parsed. Every text field was
  unbounded and all of them are stored, while `ws` accepts 100 MiB a frame by default.
  A prompt is capped at 100,000 characters and refused past it; engine output is
  capped higher and shortened by the CLI before it is sent, saying how much was cut,
  because a refused frame would be a turn the browser never sees finish. The composer
  says a prompt is too long where it is typed, since the server can only answer
  "invalid message".

**What is left on disk**

- The config, the granted permissions, and the machine id are written `0600` in a
  directory created `0700`. They followed the umask before, which is usually
  world-readable, and the grants file is the list of tool calls this machine will make
  without asking anyone. The mode is corrected on every write, so a file left loose by
  an earlier install is tightened rather than kept as it was born.

### Migration

Nothing to do by hand unless a proxy sits in front of the server. The rest applies
itself.

- `TRUST_PROXY` is new and unset by default. **A deployment behind a reverse proxy has
  to set it**, or every client will share the proxy's address and one of them will
  exhaust the rate limit for all of them. Set `true` when nothing but the proxy can
  reach the port, or name the proxy addresses to trust.
- `sessions` gains a nullable `last_activity_at`, applied by migration `0007`. A row
  written before it has none and is read as active since it was created, so an upgrade
  does not lock anyone out of their own history.
- The config file gains an optional `permission.deny`, defaulted to empty, so a config
  written before this release loads unchanged and refuses nothing outright.
- `permissions.json` is created next to the config the first time something is
  granted. An unreadable one is treated as no grants, which only means being asked
  again.
- The config, `permissions.json`, and `machine-id` are tightened to `0600` the next
  time each is written. Files that are never written again keep the mode they have, so
  `chmod 600` them if a shared machine is a concern.

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

[0.3.6]: https://github.com/adityadarma/tunnelcode/releases/tag/v0.3.6
[0.3.5]: https://github.com/adityadarma/tunnelcode/releases/tag/v0.3.5
[0.3.4]: https://github.com/adityadarma/tunnelcode/releases/tag/v0.3.4
[0.3.2]: https://github.com/adityadarma/tunnelcode/releases/tag/v0.3.2
[0.3.1]: https://github.com/adityadarma/tunnelcode/releases/tag/v0.3.1
[0.3.0]: https://github.com/adityadarma/tunnelcode/releases/tag/v0.3.0
[0.2.1]: https://github.com/adityadarma/tunnelcode/releases/tag/v0.2.1
[0.2.0]: https://github.com/adityadarma/tunnelcode/releases/tag/v0.2.0
[0.1.1]: https://github.com/adityadarma/tunnelcode/releases/tag/v0.1.1
[0.1.0]: https://github.com/adityadarma/tunnelcode/releases/tag/v0.1.0
