#!/usr/bin/env node
import { run } from './cli.js';
import { runUpdate } from './commands/update.js';
import { writeErr, writeOut } from './output.js';
import { checkForUpdate } from './update-check.js';
import { readVersion } from './version.js';

const args = process.argv.slice(2);

if (args.includes('-v') || args.includes('--version')) {
  writeOut(readVersion());
  process.exit(0);
}

if (args.includes('-h') || args.includes('--help')) {
  writeOut(`tunnelcode v${readVersion()}`);
  writeOut('');
  writeOut('Usage: tunnelcode [command] [options]');
  writeOut('');
  writeOut('Commands:');
  writeOut('  update          Update tunnelcode to the latest version');
  writeOut('');
  writeOut('Options:');
  writeOut('  -v, --version   Show version number');
  writeOut('  -h, --help      Show this help message');
  process.exit(0);
}

if (args[0] === 'update') {
  try {
    process.exitCode = await runUpdate();
  } catch (error) {
    writeErr(error instanceof Error ? error.message : 'Unexpected error.');
    process.exitCode = 1;
  }
} else {
  try {
    // Fire the update check in the background — it never blocks or throws.
    const updateCheck = checkForUpdate();

    process.exitCode = await run();

    // Wait for the check to finish so the notice prints before exit. The timeout
    // inside ensures this never blocks for more than 5 seconds.
    await updateCheck;
  } catch (error) {
    writeErr(error instanceof Error ? error.message : 'Unexpected error.');
    process.exitCode = 1;
  }
}
