import WebSocket from 'ws';
import { serverToCliMessageSchema } from '@tunnelcode/protocol';
import type { CliMessage, PermissionDecision, ServerToCliMessage } from '@tunnelcode/protocol';

/** How often the CLI pings, to notice a dead connection. */
const PING_INTERVAL_MS = 30 * 1000;

export interface PairingClientOptions {
  url: string;
  code: string;
  /**
   * Identifies this run of the CLI, the same value across every reconnect it makes.
   *
   * Sent on register so a server that restarted can reinstate what this run already
   * approved rather than asking the terminal again. See ADR-043.
   */
  runId: string;
  deviceId: string;
  deviceName: string;
  workspace: string;
  /** Version of the CLI, sent to the server for display. */
  version: string;
  /** Engines this machine can run, each with the models it reported. */
  engines: { name: string; models: string[] }[];
  /** Per-device answer timeout from config, sent to the server. */
  answerTimeoutMs?: number | undefined;
  /** Asked when the server forwards a pairing request. */
  onPairRequest: (approvalNumber: string) => Promise<boolean>;
  /**
   * Asked when a browser that paired in an earlier run wants to carry on here.
   *
   * A separate question from pairing: no code was presented, and refusing ends that
   * browser's session rather than declining a new one. See ADR-040.
   */
  onResumeRequest: (approvalNumber: string) => Promise<boolean>;
  onRegistered: (deviceId: string) => void;
  onPaired: (deviceId: string) => void;
  /** Called when the server ends the session, so the CLI can stop. */
  onStop: (reason: string) => void;
  /** fatal marks a failure that reconnecting cannot resolve. */
  onError: (message: string, fatal: boolean) => void;
  /**
   * Called when the browser asks for the running answer to stop.
   *
   * Not awaited: killing the engine is what this does, and the run itself is what
   * finishes afterwards.
   */
  onStopTurn: (turnId: string) => void;
  /** Called when the server routes a prompt from the browser to this machine. */
  onPrompt: (
    turnId: string,
    text: string,
    /** Engine the conversation runs on, always one this CLI registered. */
    engine: string,
    model: string | undefined,
    resume: string | undefined,
  ) => Promise<void>;
  /**
   * Called with what the user decided about a tool call this machine asked about.
   *
   * Not awaited: the engine is what waits, and this only hands the decision over.
   */
  onPermissionResponse: (
    turnId: string,
    permissionId: string,
    decision: PermissionDecision,
    /** True when the refusal is a deadline passing rather than a choice. */
    expired: boolean,
  ) => void;
}

/**
 * WebSocket client for pairing.
 *
 * The CLI is the only party that can approve, so the approval answer always
 * travels out over this connection. See ADR-014.
 */
export class PairingClient {
  private readonly socket: WebSocket;
  private readonly options: PairingClientOptions;
  private pingTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(options: PairingClientOptions) {
    this.options = options;
    this.socket = new WebSocket(options.url);

    this.socket.on('open', () => {
      this.send({
        type: 'register',
        code: options.code,
        runId: options.runId,
        deviceId: options.deviceId,
        deviceName: options.deviceName,
        workspace: options.workspace,
        engines: options.engines,
        version: options.version,
        ...(options.answerTimeoutMs === undefined ? {} : { answerTimeoutMs: options.answerTimeoutMs }),
      });
      this.pingTimer = setInterval(() => {
        this.send({ type: 'ping' });
      }, PING_INTERVAL_MS);
    });

    this.socket.on('message', (raw: Buffer) => {
      void this.handle(raw.toString('utf8'));
    });
  }

  /** Resolves when the connection ends, so start can wait on the session. */
  async waitUntilClosed(): Promise<void> {
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        this.stopPing();
        resolve();
      };
      this.socket.on('close', finish);
      this.socket.on('error', (error: Error) => {
        // A transport error is worth retrying: the server may just be restarting.
        this.options.onError(error.message, false);
        finish();
      });
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stopPing();
    this.socket.close();
  }

  private stopPing(): void {
    if (this.pingTimer !== undefined) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  private send(message: CliMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private async handle(raw: string): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return;
    }

    const parsed = serverToCliMessageSchema.safeParse(value);
    if (!parsed.success) {
      return;
    }

    await this.dispatch(parsed.data);
  }

  private async dispatch(message: ServerToCliMessage): Promise<void> {
    switch (message.type) {
      case 'registered':
        this.options.onRegistered(message.deviceId);
        return;

      case 'pair_request': {
        const approved = await this.options.onPairRequest(message.approvalNumber);
        this.send({
          type: approved ? 'approve' : 'reject',
          requestId: message.requestId,
        });
        return;
      }

      // Answered with the same two messages as a pairing request: the server knows
      // which one it asked, and only this connection can answer for the machine.
      case 'resume_request': {
        const approved = await this.options.onResumeRequest(message.approvalNumber);
        this.send({
          type: approved ? 'approve' : 'reject',
          requestId: message.requestId,
        });
        return;
      }

      case 'paired':
        this.options.onPaired(message.deviceId);
        return;

      case 'stop':
        this.options.onStop(message.reason);
        return;

      case 'stop_turn':
        this.options.onStopTurn(message.turnId);
        return;

      case 'error':
        this.options.onError(message.message, message.fatal ?? false);
        return;

      case 'prompt':
        await this.options.onPrompt(
          message.turnId,
          message.text,
          message.engine,
          message.model,
          message.resume,
        );
        return;

      case 'permission_response':
        this.options.onPermissionResponse(
          message.turnId,
          message.permissionId,
          message.decision,
          message.expired ?? false,
        );
        return;

      case 'pong':
        return;
    }
  }

  /** Used by the prompt runner to report engine output. */
  report(message: CliMessage): void {
    this.send(message);
  }
}
