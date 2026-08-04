import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/**
 * Prevents the machine from sleeping while the session is active.
 *
 * Each platform uses its own mechanism:
 *
 * - **macOS**: spawns `caffeinate -i`, which holds a power assertion that prevents
 *   idle sleep. Killing the process releases the assertion.
 *
 * - **Linux**: calls `systemd-inhibit` with an idle inhibit lock. The lock is held
 *   for the lifetime of the child process (a `sleep infinity` that gets killed on
 *   stop). This works on any systemd-based distro (Ubuntu, Fedora, Arch, etc.).
 *
 * - **Windows**: spawns a small PowerShell snippet that calls `SetThreadExecutionState`
 *   in a loop. The flag `ES_CONTINUOUS | ES_SYSTEM_REQUIRED` tells Windows the system
 *   is in use. Killing the process reverts to default behavior automatically.
 *
 * On unsupported platforms this is a no-op. The reconnect loop already handles
 * recovery after a sleep/wake cycle, so failing to inhibit sleep is never fatal.
 */
export class Caffeinate {
  private process: ChildProcess | undefined;

  start(): void {
    switch (process.platform) {
      case 'darwin':
        this.startDarwin();
        break;
      case 'linux':
        this.startLinux();
        break;
      case 'win32':
        this.startWindows();
        break;
      default:
        // Unsupported platform — silently skip.
        break;
    }
  }

  stop(): void {
    if (this.process !== undefined) {
      this.process.kill();
      this.process = undefined;
    }
  }

  /**
   * macOS: `caffeinate -i` prevents idle sleep for the lifetime of the process.
   */
  private startDarwin(): void {
    this.process = spawn('caffeinate', ['-i'], {
      stdio: 'ignore',
      detached: false,
    });

    this.process.on('error', () => {
      this.process = undefined;
    });

    this.process.unref();
  }

  /**
   * Linux: `systemd-inhibit --what=idle --who=tunnelcode --why="Session active"` holds
   * an inhibit lock while its child process is alive. We give it `sleep infinity` as
   * the child so the lock lasts until we kill it.
   */
  private startLinux(): void {
    this.process = spawn(
      'systemd-inhibit',
      [
        '--what=idle',
        '--who=tunnelcode',
        '--why=Tunnelcode session active',
        'sleep',
        'infinity',
      ],
      {
        stdio: 'ignore',
        detached: false,
      },
    );

    this.process.on('error', () => {
      this.process = undefined;
    });

    this.process.unref();
  }

  /**
   * Windows: a PowerShell process that calls SetThreadExecutionState in a loop.
   *
   * ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001) = 0x80000001
   * tells Windows the system must stay awake. The loop re-asserts every 30 seconds
   * in case something else resets the state. Killing the process stops the loop and
   * Windows reverts to normal power policy.
   */
  private startWindows(): void {
    const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class SleepInhibitor {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
"@
while ($true) {
    [SleepInhibitor]::SetThreadExecutionState(0x80000001) | Out-Null
    Start-Sleep -Seconds 30
}
`;

    this.process = spawn('powershell', ['-NoProfile', '-Command', script], {
      stdio: 'ignore',
      detached: false,
    });

    this.process.on('error', () => {
      this.process = undefined;
    });

    this.process.unref();
  }
}
