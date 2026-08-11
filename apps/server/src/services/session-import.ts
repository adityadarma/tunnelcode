import { randomUUID } from 'node:crypto';
import type { CliMessage } from '@tunnelcode/protocol';
import type { CliRegistry } from '../ws/registry.js';
import { PendingRequestRegistry } from './pending-requests.js';

/** The shape of a list_sessions_response message from the CLI. */
export type ListSessionsResponse = Extract<CliMessage, { type: 'list_sessions_response' }>;

/** The shape of an import_session_response message from the CLI. */
export type ImportSessionResponse = Extract<CliMessage, { type: 'import_session_response' }>;

/**
 * Orchestrates the request/response flow for listing and importing agent
 * sessions from the CLI.
 *
 * Each request is correlated by a unique id so the matching response can resolve
 * the waiting promise. Timeouts and disconnect cleanup prevent the server from
 * holding open promises indefinitely.
 */
export class SessionImportService {
  private readonly listPending: PendingRequestRegistry<ListSessionsResponse>;
  private readonly importPending: PendingRequestRegistry<ImportSessionResponse>;

  constructor(private readonly registry: CliRegistry) {
    this.listPending = new PendingRequestRegistry();
    this.importPending = new PendingRequestRegistry();
  }

  /** Sends list request to CLI and waits for response. */
  async listSessions(deviceId: string, engine: string, cwd: string): Promise<ListSessionsResponse> {
    const requestId = randomUUID();
    const sent = this.registry.send(deviceId, {
      type: 'list_sessions_request',
      requestId,
      engine,
      cwd,
    });
    if (!sent) throw new Error('Device is offline.');
    return this.listPending.create(requestId, 10_000);
  }

  /** Sends import request to CLI and waits for response. */
  async importSession(
    deviceId: string,
    engine: string,
    sessionId: string,
    cwd: string,
  ): Promise<ImportSessionResponse> {
    const requestId = randomUUID();
    const sent = this.registry.send(deviceId, {
      type: 'import_session_request',
      requestId,
      engine,
      sessionId,
      cwd,
    });
    if (!sent) throw new Error('Device is offline.');
    return this.importPending.create(requestId, 30_000);
  }

  resolveListSessions(requestId: string, response: ListSessionsResponse): void {
    this.listPending.resolve(requestId, response);
  }

  resolveImportSession(requestId: string, response: ImportSessionResponse): void {
    this.importPending.resolve(requestId, response);
  }

  /** Called when CLI disconnects. */
  rejectAllForDevice(reason: Error): void {
    this.listPending.rejectAll(reason);
    this.importPending.rejectAll(reason);
  }
}
