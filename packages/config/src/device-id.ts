import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { globalConfigPath } from './paths.js';

/**
 * Machine identity, kept next to the global config.
 *
 * This has to survive a restart: sessions in the database point at a device, so
 * a fresh value on every run would leave every earlier session permanently
 * offline. It is not a secret and grants nothing on its own.
 */
export function machineIdPath(): string {
  return join(dirname(globalConfigPath()), 'machine-id');
}

async function readOrCreateMachineId(): Promise<string> {
  const path = machineIdPath();

  try {
    const existing = (await readFile(path, 'utf8')).trim();

    if (existing !== '') {
      return existing;
    }
  } catch {
    // Missing or unreadable means this machine has no id yet.
  }

  const created = randomUUID();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Owner-only like everything else in this directory. It grants nothing by
  // itself, but every device id on this machine is derived from it, and there is
  // no reason for another account to be able to work them out. See ADR-029.
  await writeFile(path, `${created}\n`, { encoding: 'utf8', mode: 0o600 });
  return created;
}

/**
 * Device id for one workspace on this machine.
 *
 * Derived from the machine id and the workspace path so it is stable across
 * restarts while still being distinct per workspace. Two agents running in
 * different directories are genuinely different devices: each has its own
 * engine and its own files, so prompts must not be routed between them.
 */
export async function readOrCreateDeviceId(workspace: string): Promise<string> {
  const machineId = await readOrCreateMachineId();
  const digest = createHash('sha256').update(`${machineId}:${workspace}`).digest('hex');

  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join('-');
}
