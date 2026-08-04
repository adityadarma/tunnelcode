import { useCallback, useEffect, useRef, useState } from 'react';
import { readSession } from '../api.js';

interface FileChangesPageProps {
  sessionId: string;
  onBack: () => void;
}

interface FileChange {
  path: string;
  status: string;
  diff?: string;
}

function statusLabel(status: string): string {
  switch (status) {
    case 'M':
      return 'Modified';
    case 'A':
      return 'Added';
    case 'D':
      return 'Deleted';
    case 'U':
      return 'Untracked';
    case 'R':
      return 'Renamed';
    case 'C':
      return 'Copied';
    default:
      return status;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'M':
      return 'var(--accent)';
    case 'A':
    case 'U':
      return 'var(--ok)';
    case 'D':
      return 'var(--danger)';
    default:
      return 'var(--muted)';
  }
}

function fileIcon(status: string): React.JSX.Element {
  const color = statusColor(status);

  if (status === 'D') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    );
  }

  if (status === 'A' || status === 'U') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
        <path d="M12 5v14M5 12h14" />
      </svg>
    );
  }

  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function fileName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

function fileDir(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
}

/** Parsed line from a unified diff. */
interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'hunk' | 'header';
  oldNum: number | null;
  newNum: number | null;
  text: string;
}

/** Parses unified diff output into structured lines with line numbers. */
function parseDiff(diff: string): DiffLine[] {
  const raw = diff.split('\n');
  const result: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of raw) {
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = parseInt(match[1] ?? '0', 10);
        newLine = parseInt(match[2] ?? '0', 10);
      }
      // Skip hunk headers from display
    } else if (
      line.startsWith('+++') ||
      line.startsWith('---') ||
      line.startsWith('diff ') ||
      line.startsWith('index ')
    ) {
      // Skip file headers
    } else if (line.startsWith('+')) {
      result.push({ type: 'add', oldNum: null, newNum: newLine, text: line.slice(1) });
      newLine++;
    } else if (line.startsWith('-')) {
      result.push({ type: 'del', oldNum: oldLine, newNum: null, text: line.slice(1) });
      oldLine++;
    } else {
      // Context line — show as normal code
      const text = line.startsWith(' ') ? line.slice(1) : line;
      result.push({ type: 'ctx', oldNum: oldLine, newNum: newLine, text });
      oldLine++;
      newLine++;
    }
  }

  return result;
}

/** Counts added and deleted lines in a diff. */
function diffStats(diff: string | undefined): { added: number; deleted: number } {
  if (!diff) return { added: 0, deleted: 0 };
  let added = 0;
  let deleted = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) deleted++;
  }
  return { added, deleted };
}

/** Renders a diff with line numbers and syntax coloring. */
function DiffView({ diff }: { diff: string }): React.JSX.Element {
  const lines = parseDiff(diff);
  const firstChangeRef = useRef<HTMLTableRowElement | null>(null);
  const markedFirst = useRef(false);

  useEffect(() => {
    markedFirst.current = false;
  }, [diff]);

  useEffect(() => {
    if (firstChangeRef.current) {
      firstChangeRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [diff]);

  return (
    <table className="fc-diff-table">
      <tbody>
        {lines.map((line, i) => {
          const isChange = line.type === 'add' || line.type === 'del';
          const isFirst = isChange && !markedFirst.current;
          if (isFirst) markedFirst.current = true;

          return (
            <tr
              key={i}
              ref={isFirst ? firstChangeRef : undefined}
              className={`fc-diff-row fc-diff-row-${line.type}`}
            >
              <td className="fc-diff-gutter fc-diff-gutter-old">{line.oldNum ?? ''}</td>
              <td className="fc-diff-gutter fc-diff-gutter-new">{line.newNum ?? ''}</td>
              <td className="fc-diff-marker">
                {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ''}
              </td>
              <td className="fc-diff-code">
                <span>{line.text || '\u00A0'}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function FileChangesPage({ sessionId, onBack }: FileChangesPageProps): React.JSX.Element {
  const [files, setFiles] = useState<FileChange[]>([]);
  const [selectedFile, setSelectedFile] = useState<FileChange | undefined>(undefined);
  const [connected, setConnected] = useState(false);
  const [workspace, setWorkspace] = useState<string | undefined>(undefined);
  const socketRef = useRef<WebSocket | undefined>(undefined);

  // Fetch session workspace for display
  useEffect(() => {
    void (async () => {
      try {
        const session = await readSession(sessionId);
        setWorkspace(session.workspace);
      } catch {
        // Ignore
      }
    })();
  }, [sessionId]);

  // Connect WebSocket to receive file_changes events
  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | undefined;

    const connect = (): void => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${window.location.host}/ws/browser`;
      const socket = new WebSocket(url);
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        setConnected(true);
        socket.send(JSON.stringify({ type: 'attach', sessionId }));
      });

      socket.addEventListener('message', (event: MessageEvent<string>) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          return;
        }

        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'type' in parsed &&
          (parsed as Record<string, unknown>).type === 'file_changes' &&
          'files' in parsed
        ) {
          const msg = parsed as { type: 'file_changes'; files: FileChange[] };
          setFiles(msg.files);

          // Auto-select first file if nothing is selected or selection is gone
          setSelectedFile((prev) => {
            if (msg.files.length === 0) return undefined;
            if (prev && msg.files.some((f) => f.path === prev.path)) {
              // Update current selection with latest data
              return msg.files.find((f) => f.path === prev.path);
            }
            return msg.files[0];
          });
        }
      });

      socket.addEventListener('close', () => {
        setConnected(false);
        if (!disposed) {
          reconnectTimer = window.setTimeout(connect, 2000);
        }
      });
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      socketRef.current?.close();
      socketRef.current = undefined;
    };
  }, [sessionId]);

  const handleSelectFile = useCallback((file: FileChange) => {
    setSelectedFile(file);
    setMenuOpen(false);
  }, []);

  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className={`fc-layout ${menuOpen ? 'fc-menu-open' : ''}`}>
      {/* Header */}
      <header className="fc-header">
        <div className="fc-header-left">
          <button type="button" className="fc-back-btn" onClick={onBack} aria-label="Go back">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          {/* Hamburger for mobile — opens the file list drawer */}
          <button
            type="button"
            className="fc-menu-btn"
            onClick={() => {
              setMenuOpen(!menuOpen);
            }}
            aria-label="Toggle file list"
          >
            ☰
          </button>
          <h1 className="fc-title">Changed Files</h1>
          {workspace && <span className="fc-workspace">{workspace}</span>}
        </div>
        <div className="fc-header-right">
          <span className={`fc-status-dot ${connected ? 'online' : 'offline'}`} />
          <span className="fc-status-label">{connected ? 'Live' : 'Connecting…'}</span>
        </div>
      </header>

      {/* Main content area */}
      <div className="fc-body">
        {!connected ? (
          <div className="fc-empty">
            <span className="pulse-dot" />
            <p className="muted">Connecting to device…</p>
          </div>
        ) : files.length === 0 ? (
          <div className="fc-empty">
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--ok)"
              strokeWidth="1.5"
            >
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <p className="muted">Working directory clean — no changes.</p>
          </div>
        ) : (
          <>
            {/* Overlay for mobile drawer */}
            <div
              className="fc-overlay"
              onClick={() => {
                setMenuOpen(false);
              }}
            />

            {/* File sidebar */}
            <aside className="fc-sidebar">
              <div className="fc-sidebar-head">
                <span className="fc-sidebar-count">
                  {files.length} change{files.length !== 1 ? 's' : ''}
                </span>
              </div>
              <ul className="fc-file-list" role="listbox" aria-label="Changed files">
                {files.map((file) => {
                  const stats = diffStats(file.diff);
                  return (
                    <li
                      key={file.path}
                      role="option"
                      aria-selected={selectedFile?.path === file.path}
                    >
                      <button
                        type="button"
                        className={`fc-file-item ${selectedFile?.path === file.path ? 'active' : ''}`}
                        onClick={() => {
                          handleSelectFile(file);
                        }}
                      >
                        <span className="fc-file-icon">{fileIcon(file.status)}</span>
                        <span className="fc-file-info">
                          <span className="fc-file-name">{fileName(file.path)}</span>
                          <span className="fc-file-dir">{fileDir(file.path)}</span>
                        </span>
                        <span className="fc-file-stats">
                          {stats.added > 0 && <span className="fc-stat-add">+{stats.added}</span>}
                          {stats.deleted > 0 && (
                            <span className="fc-stat-del">-{stats.deleted}</span>
                          )}
                          {stats.added === 0 && stats.deleted === 0 && (
                            <span
                              className="fc-file-status"
                              style={{ color: statusColor(file.status) }}
                            >
                              {file.status}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </aside>

            {/* File content viewer */}
            <main className="fc-content">
              {selectedFile ? (
                <>
                  <div className="fc-content-head">
                    <span className="fc-content-icon">{fileIcon(selectedFile.status)}</span>
                    <span className="fc-content-path">{selectedFile.path}</span>
                    <span
                      className="fc-content-tool"
                      style={{ color: statusColor(selectedFile.status) }}
                    >
                      {statusLabel(selectedFile.status)}
                    </span>
                  </div>
                  <div className="fc-content-body">
                    {selectedFile.diff ? (
                      <DiffView diff={selectedFile.diff} />
                    ) : (
                      <div className="fc-no-output">
                        <p className="muted">
                          {selectedFile.status === 'D'
                            ? 'File was deleted.'
                            : 'No diff available for this file.'}
                        </p>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="fc-empty">
                  <p className="muted">Select a file to view its diff.</p>
                </div>
              )}
            </main>
          </>
        )}
      </div>
    </div>
  );
}
