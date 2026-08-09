/**
 * Which sessions the CLI run now connected has agreed to serve.
 *
 * A session outlives the process that approved it: the row is in the database and
 * the device id is derived from the machine and the workspace, so the next
 * `tunnelcode` in that directory answers to the same address. That is what makes a
 * restart resumable, and it is also what made one approval enough for every run
 * that followed it. This is the record of what the run in front of the user has
 * agreed to, and it is deliberately memory only: a run cannot outlive the process,
 * so neither can its consent. See ADR-040.
 *
 * Keyed on the pairing code because that is what tells a restart from a reconnect.
 * The code is generated once per CLI session and reused for every reconnect within
 * it, so a dropped connection keeps its approvals and a new process does not. The
 * code is held here, in memory, and never written down; ADR-014 is about persisting
 * it, which would outlive its meaning.
 */
export class RunApprovals {
  private readonly runs = new Map<string, { code: string; sessions: Set<string> }>();

  /**
   * Records that a CLI has registered, and returns whether it is a run this has
   * not seen before.
   *
   * A new run starts with nothing approved, which is the whole point: everything
   * the previous one was trusted with has to be agreed to again.
   */
  start(deviceId: string, code: string): boolean {
    const existing = this.runs.get(deviceId);

    if (existing !== undefined && existing.code === code) {
      return false;
    }

    this.runs.set(deviceId, { code, sessions: new Set() });
    return true;
  }

  /** Called when the terminal approves, whether by pairing or by resuming. */
  allow(deviceId: string, sessionId: string): void {
    this.runs.get(deviceId)?.sessions.add(sessionId);
  }

  /**
   * Whether this session may act on this device right now.
   *
   * Absent means no: a device with no run recorded has no CLI in front of anybody,
   * and a server that just restarted knows nothing about what was approved before
   * it. Asking again costs a keypress; assuming costs the machine.
   */
  isAllowed(deviceId: string, sessionId: string): boolean {
    return this.runs.get(deviceId)?.sessions.has(sessionId) ?? false;
  }
}
