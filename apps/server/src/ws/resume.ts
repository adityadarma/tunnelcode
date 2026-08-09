import type { SessionService } from '../services/session.js';
import type { BrowserRegistry } from './browser-registry.js';
import type { CliRegistry } from './registry.js';

export interface ResumeOptions {
  deviceId: string;
  sessionId: string;
  sessions: SessionService;
  registry: CliRegistry;
  browsers: BrowserRegistry;
}

/**
 * Asks the terminal to serve a session it has not agreed to in this run.
 *
 * Called from two places that are the same question at different moments: a
 * browser attaching to a machine that is already back, and a machine coming back
 * to a browser that is already attached. Keeping it in one function is what stops
 * those two from asking in two different ways. See ADR-040.
 *
 * Returns the number both sides show, or undefined when there is no CLI to ask,
 * which is not a failure: the browser reads its history offline and is asked the
 * moment the machine registers again.
 */
export function requestResume(options: ResumeOptions): string | undefined {
  const { deviceId, sessionId, sessions, registry, browsers } = options;

  if (!registry.isConnected(deviceId)) {
    return undefined;
  }

  const { request, asked } = sessions.createPendingResume(deviceId, sessionId);

  // Only once per question. A browser reconnecting, or a second tab arriving, must
  // not put the same number in front of the user again: the terminal is waiting on a
  // keypress, and repeating the prompt would read as a second machine asking.
  if (!asked) {
    registry.send(deviceId, {
      type: 'resume_request',
      requestId: request.id,
      approvalNumber: request.approvalNumber,
    });
  }

  // Every browser on the session, not only the one that asked: the approval covers
  // the session, so a second tab must not be left showing a usable composer while
  // the terminal is still deciding.
  browsers.broadcast(sessionId, {
    type: 'resume_pending',
    sessionId,
    approvalNumber: request.approvalNumber,
  });

  return request.approvalNumber;
}
