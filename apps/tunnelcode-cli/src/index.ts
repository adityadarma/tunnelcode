#!/usr/bin/env node
import { run } from './cli.js';
import { writeErr } from './output.js';

// No argument parsing and no .env: every setting comes from the menu, so the
// server this agent talks to cannot be changed by a flag, an environment
// variable, or a .env file in whatever directory it was started from. See ADR-018.
try {
  process.exitCode = await run();
} catch (error) {
  writeErr(error instanceof Error ? error.message : 'Unexpected error.');
  process.exitCode = 1;
}
