import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CliMessage } from '@tunnelcode/protocol';

const exec = promisify(execFile);

/** How often to check for file changes. */
const POLL_INTERVAL_MS = 5000;

/** Maximum diff size per file before truncating. */
const MAX_DIFF_LENGTH = 500_000;

interface FileChange {
  path: string;
  status: string;
  diff?: string;
}

export interface FileWatcherOptions {
  cwd: string;
  send: (message: CliMessage) => void;
}

/**
 * Watches git file changes in the workspace and sends them to the server.
 *
 * Polls `git status` periodically and sends a `file_changes` message with the
 * diff of each changed file. Only active when the workspace is a git repo.
 */
export class FileWatcher {
  private readonly options: FileWatcherOptions;
  private timer: NodeJS.Timeout | undefined;
  private lastSnapshot = '';

  constructor(options: FileWatcherOptions) {
    this.options = options;
  }

  start(): void {
    if (this.timer !== undefined) return;

    // Initial check right away, then poll.
    void this.check();
    this.timer = setInterval(() => {
      void this.check();
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async check(): Promise<void> {
    try {
      const files = await this.getChangedFiles();

      // Only send when something actually changed, to avoid pointless traffic.
      const snapshot = files.map((f) => `${f.status}:${f.path}`).join('\n');
      if (snapshot === this.lastSnapshot) return;
      this.lastSnapshot = snapshot;

      if (files.length === 0) {
        // Send empty list so the browser knows the workspace is clean.
        this.options.send({ type: 'file_changes', files: [] });
        return;
      }

      // Fetch diffs for each changed file (not for deleted/untracked).
      const filesWithDiff = await this.enrichWithDiffs(files);

      this.options.send({ type: 'file_changes', files: filesWithDiff });
    } catch {
      // Not a git repo or git not available. Silent.
    }
  }

  private async getChangedFiles(): Promise<FileChange[]> {
    const { stdout } = await exec('git', ['status', '--porcelain', '-uall'], {
      cwd: this.options.cwd,
      timeout: 5000,
    });

    if (!stdout.trim()) return [];

    const files: FileChange[] = [];

    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;

      // Format: XY path  or  XY old -> new (for renames)
      const status = line.slice(0, 2).trim();
      let filePath = line.slice(3);

      // Handle renames
      const arrowIndex = filePath.indexOf(' -> ');
      if (arrowIndex !== -1) {
        filePath = filePath.slice(arrowIndex + 4);
      }

      if (status && filePath) {
        // Normalize git porcelain status to single-char labels like VS Code:
        // ?? → U (untracked), A → A (added), M → M (modified), D → D (deleted)
        const normalized = status === '??' ? 'U' : status.charAt(0);
        files.push({ path: filePath, status: normalized });
      }
    }

    return files;
  }

  private async enrichWithDiffs(files: FileChange[]): Promise<FileChange[]> {
    const result: FileChange[] = [];

    for (const file of files) {
      let diff: string | undefined;

      try {
        if (file.status === 'U' || file.status === 'A') {
          // Untracked or added: show the whole file content as "new"
          const { stdout } = await exec('git', ['diff', '--no-index', '/dev/null', file.path], {
            cwd: this.options.cwd,
            timeout: 5000,
          }).catch((error: unknown) => {
            // git diff --no-index exits with 1 when there are differences (normal behavior)
            const err = error as { stdout?: string };
            if (err.stdout) return { stdout: err.stdout };
            throw error;
          });
          diff = stdout.slice(0, MAX_DIFF_LENGTH);
        } else if (file.status !== 'D') {
          // Modified: get the full file diff with all context lines
          const { stdout } = await exec('git', ['diff', '-U9999', '--', file.path], {
            cwd: this.options.cwd,
            timeout: 5000,
          });

          if (!stdout.trim()) {
            // Might be staged
            const staged = await exec('git', ['diff', '--cached', '-U9999', '--', file.path], {
              cwd: this.options.cwd,
              timeout: 5000,
            });
            diff = staged.stdout.slice(0, MAX_DIFF_LENGTH);
          } else {
            diff = stdout.slice(0, MAX_DIFF_LENGTH);
          }
        }
      } catch {
        // Could not get diff for this file, continue without it.
      }

      result.push({
        path: file.path,
        status: file.status,
        ...(diff ? { diff } : {}),
      });
    }

    return result;
  }
}
