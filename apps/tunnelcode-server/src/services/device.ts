/**
 * A device is a CLI process that registered a pairing code. Devices live in
 * memory only: a restarted server means every CLI has to register again, which
 * is correct because a code is only valid while its CLI session runs.
 * See ADR-006 and ADR-014.
 */
export interface Device {
  id: string;
  name: string;
  code: string;
  /** Where the CLI is running, recorded with the session when it pairs. */
  workspace: string;
  engine: string;
  /** Models the engine reported, the only models a browser may choose. */
  models: string[];
  /** True once a browser has paired with this device. */
  paired: boolean;
  createdAt: number;
}

/**
 * Why a registration was refused.
 *
 * The two cases need different wording: a taken code means somebody else holds
 * it, while a busy workspace means this machine is already running an agent here.
 */
export type RegisterFailure = 'code_taken' | 'workspace_busy';

export type RegisterResult = { ok: true; device: Device } | { ok: false; reason: RegisterFailure };

export interface RegisterDeviceInput {
  id: string;
  code: string;
  name: string;
  workspace: string;
  engine: string;
  models: string[];
}

export interface DeviceServiceOptions {
  /**
   * Whether a device still has a live CLI connection.
   *
   * A device is only forgotten when its socket closes, so a connection that died
   * without one leaves an entry behind. Asking the connection registry is the
   * only way to tell a running session from that leftover.
   */
  isConnected: (deviceId: string) => boolean;
}

export class DeviceService {
  private readonly byId = new Map<string, Device>();
  private readonly byCode = new Map<string, string>();
  private readonly isConnected: (deviceId: string) => boolean;

  constructor(options: DeviceServiceOptions) {
    this.isConnected = options.isConnected;
  }

  /**
   * Registers a CLI under a pairing code. Refuses when the code or the workspace
   * belongs to a different live session, so two CLI sessions can never share one
   * code.
   *
   * The same device re-registering the same code is a reconnect: the stale entry
   * is replaced, because the old socket is gone. Without this a CLI that lost
   * its connection could never come back under the code already on screen.
   */
  register(input: RegisterDeviceInput): RegisterResult {
    const holderId = this.byCode.get(input.code);

    if (holderId !== undefined && holderId !== input.id) {
      // A code is only valid while its CLI session runs, so a holder with no
      // live connection has no claim on it. Refusing here would retire the code
      // until the server restarts, and the CLI treats the refusal as fatal.
      if (this.isConnected(holderId)) {
        return { ok: false, reason: 'code_taken' };
      }

      this.remove(holderId);
    }

    let existing = this.byId.get(input.id);

    // Same workspace on the same machine, but a different code: another agent is
    // already running here. Its code is the one on screen, so this one can never
    // be paired and retrying cannot help.
    if (existing !== undefined && existing.code !== input.code) {
      if (this.isConnected(input.id)) {
        return { ok: false, reason: 'workspace_busy' };
      }

      // No live connection means this is a restart, not a second agent. The old
      // code died with its session, so nothing about it is carried over.
      this.remove(input.id);
      existing = undefined;
    }

    const device: Device = {
      id: input.id,
      name: input.name,
      code: input.code,
      workspace: input.workspace,
      engine: input.engine,
      models: input.models,
      // A reconnect keeps the paired flag: the code is single use, so it must not
      // become claimable again just because the connection dropped.
      paired: existing?.paired ?? false,
      createdAt: existing?.createdAt ?? Date.now(),
    };

    this.byId.set(device.id, device);
    this.byCode.set(device.code, device.id);
    return { ok: true, device };
  }

  findByCode(code: string): Device | undefined {
    const id = this.byCode.get(code);
    return id === undefined ? undefined : this.byId.get(id);
  }

  findById(id: string): Device | undefined {
    return this.byId.get(id);
  }

  markPaired(id: string): void {
    const device = this.byId.get(id);
    if (device !== undefined) {
      device.paired = true;
    }
  }

  /**
   * Removes a device and frees its code. Called when the CLI disconnects, so a
   * code is never reusable after its session ends.
   */
  remove(id: string): void {
    const device = this.byId.get(id);
    if (device === undefined) {
      return;
    }
    this.byCode.delete(device.code);
    this.byId.delete(id);
  }

  count(): number {
    return this.byId.size;
  }
}
