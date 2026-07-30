#!/usr/bin/env node
import { loadEnvFile } from '@remotecode/shared';
import { run } from './cli.js';
import { writeErr } from './output.js';

// Before any command reads process.env, so a .env file can point the CLI at a
// server without editing the stored config.
loadEnvFile();

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  writeErr(error instanceof Error ? error.message : 'Unexpected error.');
  process.exitCode = 1;
}
