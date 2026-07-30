export const HELP_TEXT = `remotecode - run an AI coding agent locally, control it from the browser

Usage
  remotecode [command] [options]

Commands
  start            Start the agent (default when no command is given)
  setup            Set up global configuration
  init             Create project configuration
  doctor           Validate the environment

Options
  -h, --help       Show this help
  -v, --version    Show the version
  -f, --force      Overwrite an existing config file
  --server <url>   Server URL, used by setup
  --device <name>  Device name, used by setup
  --engine <name>  Engine name, used by setup and init
  --prompt <text>  Send one prompt straight to the engine, used by start

Engines
  opencode         OpenCode CLI
  claude           Claude Code CLI
`;
