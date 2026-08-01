#!/usr/bin/env node
import { run } from './cli.js';
import { writeErr, writeOut } from './output.js';
import { readVersion } from './version.js';

const args = process.argv.slice(2);

if (args.includes('-v') || args.includes('--version')) {
  writeOut(readVersion());
  process.exit(0);
}

if (args.includes('-h') || args.includes('--help')) {
  writeOut(`tunnelcode v${readVersion()}`);
  writeOut('');
  writeOut('Usage: tunnelcode [options]');
  writeOut('');
  writeOut('Options:');
  writeOut('  -v, --version  Show version number');
  writeOut('  -h, --help     Show this help message');
  process.exit(0);
}

try {
  process.exitCode = await run();
} catch (error) {
  writeErr(error instanceof Error ? error.message : 'Unexpected error.');
  process.exitCode = 1;
}
