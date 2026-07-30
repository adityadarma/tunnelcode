const DEFAULT_LEVEL = 'info';
const VALID_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

type Level = (typeof VALID_LEVELS)[number];

function isLevel(value: string): value is Level {
  return (VALID_LEVELS as readonly string[]).includes(value);
}

interface LoggerOptions {
  level: Level;
  redact: {
    paths: string[];
    censor: string;
  };
}

function readLevel(): Level {
  const raw = process.env['LOG_LEVEL'];

  if (raw === undefined || raw === '' || !isLevel(raw)) {
    return DEFAULT_LEVEL;
  }

  return raw;
}

/**
 * Logger configuration.
 *
 * Pairing codes and approval numbers are redacted: logs outlive a session, and
 * anything written here can end up in a log aggregator the user does not
 * control. See ADR-014.
 */
export function buildLoggerOptions(): LoggerOptions {
  return {
    level: readLevel(),
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'code',
        'approvalNumber',
        '*.code',
        '*.approvalNumber',
      ],
      censor: '[redacted]',
    },
  };
}
