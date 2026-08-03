import { buildApp } from './app.js';
import { loadEnvFile } from '@tunnelcode/shared';

// Before anything reads process.env, so a .env file can shape host, port,
// database location, and log level.
const envFile = loadEnvFile();

const DEFAULT_PORT = 3000;

/**
 * Binds to loopback by default. Exposing the server means exposing an agent that
 * can read and write the local filesystem, so reaching it from another machine
 * has to be an explicit choice. In Docker, HOST is set to 0.0.0.0 and the
 * published port is what controls access.
 */
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_DATABASE_FILE = 'data/tunnelcode.sqlite';

/** How long to let in-flight requests finish before forcing exit. */
const SHUTDOWN_GRACE_MS = 10 * 1000;

function readPort(): number {
  const raw = process.env['PORT'];
  if (raw === undefined || raw === '') {
    return DEFAULT_PORT;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT;
}

function readHost(): string {
  const raw = process.env['HOST'];
  return raw === undefined || raw === '' ? DEFAULT_HOST : raw;
}

/**
 * Database location. Kept configurable so a Docker deployment can point it at a
 * mounted volume instead of the container filesystem.
 */
function readDatabaseFile(): string {
  const raw = process.env['DATABASE_FILE'];
  return raw === undefined || raw === '' ? DEFAULT_DATABASE_FILE : raw;
}

/**
 * Whether to believe a forwarded client address, and from whom.
 *
 * Unset means the connection's own address is the only one trusted. `true` trusts
 * every hop, which is only honest when nothing can reach the server except the
 * proxy; anything else is passed to Fastify as the addresses to trust, so a
 * deployment can name its proxy instead. See ADR-027.
 */
function readTrustProxy(): boolean | string | undefined {
  const raw = process.env['TRUST_PROXY'];

  if (raw === undefined || raw === '') {
    return undefined;
  }

  if (raw === 'true') {
    return true;
  }

  return raw === 'false' ? undefined : raw;
}

const trustProxy = readTrustProxy();

const app = await buildApp({
  logger: true,
  databaseFile: readDatabaseFile(),
  ...(trustProxy === undefined ? {} : { trustProxy }),
});

// Reported so a .env that was expected but not found is visible, rather than the
// server quietly listening somewhere else.
if (envFile === undefined) {
  app.log.debug('No .env file found.');
} else {
  app.log.info({ file: envFile }, 'Loaded environment file.');
}

/**
 * Closes the server once, so a second signal cannot start a parallel shutdown.
 * The database is closed by the onClose hook, which keeps WAL files consistent.
 */
let closing = false;

async function shutdown(signal: string): Promise<void> {
  if (closing) {
    return;
  }

  closing = true;
  app.log.info({ signal }, 'Shutting down.');

  const forceExit = setTimeout(() => {
    app.log.warn('Shutdown timed out, exiting.');
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  forceExit.unref();

  try {
    await app.close();
  } catch (error) {
    app.log.error({ err: error }, 'Shutdown failed.');
    process.exitCode = 1;
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

// A crash must not leave the process running in a broken state, and the log is
// the only place that can explain why it stopped.
process.on('uncaughtException', (error) => {
  app.log.fatal({ err: error }, 'Uncaught exception.');
  void shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  app.log.fatal({ err: reason }, 'Unhandled rejection.');
  void shutdown('unhandledRejection');
});

try {
  await app.listen({ host: readHost(), port: readPort() });
} catch (error) {
  app.log.error({ err: error }, 'Cannot start the server.');
  process.exitCode = 1;
}
