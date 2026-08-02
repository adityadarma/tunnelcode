import type { FastifyRequest } from 'fastify';

const DEFAULT_LEVEL = 'info';
const VALID_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

type Level = (typeof VALID_LEVELS)[number];

function isLevel(value: string): value is Level {
  return (VALID_LEVELS as readonly string[]).includes(value);
}

function readLevel(): Level {
  const raw = process.env['LOG_LEVEL'];

  if (raw === undefined || raw === '' || !isLevel(raw)) {
    return DEFAULT_LEVEL;
  }

  return raw;
}

/** What stands in for something withheld, matching the censor used for fields. */
const CENSOR = '[redacted]';

/** What stands in for an id, which says a route was called without naming what. */
const ID_PLACEHOLDER = '[id]';

/**
 * Route segments the next segment is an id for, rather than more of the route.
 *
 * A session id is the whole credential a browser holds, and a pairing request id
 * is what the approved session id is collected with, so both are secrets that
 * travel in a path. Conversation ids are not credentials, but they name a
 * transcript and there is no reason for a log to carry one either.
 */
const PRECEDES_ID = new Set(['sessions', 'conversations', 'pair']);

/**
 * A request URL with the secrets in it taken out.
 *
 * Logs outlive a session and can end up in an aggregator the user does not
 * control, which is the same reasoning that redacts pairing codes from log
 * fields. The fields were never where the code actually travelled: it arrives in
 * the query string of the QR link, and the session id arrives as a path segment,
 * so both were written out in full on every request. Redacting field names alone
 * left the two most useful secrets in the one place nobody had looked.
 *
 * The shape of the route is kept, because a log that cannot say which endpoint
 * was called is not worth keeping. Only the values are withheld. See ADR-014.
 */
export function sanitizeUrl(url: string): string {
  const mark = url.indexOf('?');
  const path = mark === -1 ? url : url.slice(0, mark);
  const query = mark === -1 ? undefined : url.slice(mark + 1);

  const segments = path.split('/');
  const masked = segments
    .map((segment, index) => {
      // Judged against the original neighbour rather than the masked one, so a
      // route that continues after an id is still readable as itself.
      const previous = index === 0 ? undefined : segments[index - 1];

      return segment !== '' && previous !== undefined && PRECEDES_ID.has(previous)
        ? ID_PLACEHOLDER
        : segment;
    })
    .join('/');

  if (query === undefined) {
    return masked;
  }

  // Names are kept and values are not: which parameters were sent is part of
  // knowing what was called, while the values are what has to be guarded.
  const names = [...new URLSearchParams(query).keys()];

  return names.length === 0
    ? masked
    : `${masked}?${names.map((name) => `${name}=${CENSOR}`).join('&')}`;
}

/** The request as a log line describes it, which is never the URL as it arrived. */
interface RequestLog {
  method: string;
  url: string;
  host: string;
  remoteAddress: string;
  /** Absent rather than null on a socket that has no peer port to report. */
  remotePort?: number;
  /** Present because the shape Fastify expects allows a serializer to add fields. */
  [key: string]: unknown;
}

interface LoggerOptions {
  level: Level;
  redact: {
    paths: string[];
    censor: string;
  };
  serializers: {
    req: (request: FastifyRequest) => RequestLog;
  };
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
        // The session header is the credential the conversation routes are called
        // with. The request serializer below reports no headers at all, so this
        // only matters for anything that logs a request some other way.
        'req.headers["x-tunnelcode-session"]',
        'code',
        'approvalNumber',
        '*.code',
        '*.approvalNumber',
      ],
      censor: CENSOR,
    },
    serializers: {
      // Replaces Fastify's own, which reports the URL exactly as it arrived.
      req: (request) => ({
        method: request.method,
        url: sanitizeUrl(request.url),
        host: request.host,
        remoteAddress: request.ip,
        ...(request.socket.remotePort === undefined
          ? {}
          : { remotePort: request.socket.remotePort }),
      }),
    },
  };
}
