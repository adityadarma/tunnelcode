import { parseArgs } from 'node:util';
import { HELP_TEXT } from './help.js';
import { writeErr, writeOut } from './output.js';
import { readVersion } from './version.js';
import { runDoctor } from './commands/doctor.js';
import { runInit } from './commands/init.js';
import { runSetup } from './commands/setup.js';
import { runStart } from './commands/start.js';

const COMMANDS = ['start', 'setup', 'init', 'doctor'] as const;

type Command = (typeof COMMANDS)[number];

interface ParsedFlags {
  help?: boolean;
  version?: boolean;
  force?: boolean;
  server?: string;
  device?: string;
  engine?: string;
  prompt?: string;
}

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

async function runCommand(command: Command, flags: ParsedFlags): Promise<number> {
  const force = flags.force ?? false;

  switch (command) {
    case 'start':
      return runStart({
        ...(flags.prompt !== undefined ? { prompt: flags.prompt } : {}),
      });
    case 'setup':
      return runSetup({
        force,
        ...(flags.server !== undefined ? { serverUrl: flags.server } : {}),
        ...(flags.device !== undefined ? { deviceName: flags.device } : {}),
        ...(flags.engine !== undefined ? { engine: flags.engine } : {}),
      });
    case 'init':
      return runInit({
        force,
        ...(flags.engine !== undefined ? { engine: flags.engine } : {}),
      });
    case 'doctor':
      return runDoctor();
  }
}

/**
 * Parses argv and dispatches to a command. Returns the process exit code so the
 * entrypoint stays the only place that touches process state.
 */
export async function run(argv: readonly string[]): Promise<number> {
  let flags: ParsedFlags;
  let positionals: string[];

  try {
    const parsed = parseArgs({
      args: [...argv],
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        force: { type: 'boolean', short: 'f' },
        server: { type: 'string' },
        device: { type: 'string' },
        engine: { type: 'string' },
        prompt: { type: 'string' },
      },
      allowPositionals: true,
    });
    flags = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    writeErr(error instanceof Error ? error.message : 'Failed to parse arguments.');
    writeErr('Run tunnelcode --help to see available options.');
    return 1;
  }

  if (flags.help === true) {
    writeOut(HELP_TEXT);
    return 0;
  }

  if (flags.version === true) {
    writeOut(readVersion());
    return 0;
  }

  // No command means start, so `tunnelcode` alone starts the agent.
  const name = positionals[0] ?? 'start';

  if (!isCommand(name)) {
    writeErr(`Unknown command: ${name}`);
    writeErr('Run tunnelcode --help to see available commands.');
    return 1;
  }

  return runCommand(name, flags);
}
