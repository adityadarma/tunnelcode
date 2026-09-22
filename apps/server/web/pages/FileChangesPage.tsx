import { useCallback, useEffect, useRef, useState } from 'react';
import { readSession } from '../api.js';
import type { SessionDetail } from '../api.js';
import { useSharedSessionSocket } from '../SessionSocketContext.js';
import { DevicePanel } from '../components/DevicePanel.js';
import { SidebarBrand } from '../components/SidebarBrand.js';
import { ThemeToggle } from '../components/ThemeToggle.js';
import { ViewToggle } from '../components/ViewToggle.js';
import type { FileChange } from '../useSessionSocket.js';
import type { Theme } from '../useTheme.js';

interface FileChangesPageProps {
  sessionId: string;
  onBack: () => void;
  /** The chosen theme, held above both screens so one switch governs them. */
  theme: Theme;
  onToggleTheme: () => void;
  /**
   * Retires the session, the same call the conversation's panel makes.
   *
   * Passed in rather than done here, because ending a session is what sends the
   * browser back to pairing, and that is not this screen's decision to make.
   */
  onSessionLost: () => void;
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

export function FileChangesPage({
  sessionId,
  onBack,
  theme,
  onToggleTheme,
  onSessionLost,
}: FileChangesPageProps): React.JSX.Element {
  const [session, setSession] = useState<SessionDetail | undefined>(undefined);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  /**
   * Dismisses whichever sidebar is on screen.
   *
   * Two different states, same as the conversation: below md the file list is a
   * drawer over the diff, held open by menuOpen, and from md up it is a column
   * beside it, held open by sidebarOpen. The drawer being open is what tells the two
   * apart, so no viewport has to be measured here.
   */
  const dismissSidebar = (): void => {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }

    setSidebarOpen(false);
  };

  /**
   * The file on screen, held as a path rather than the change itself.
   *
   * The device reports the whole list again on every edit, so a stored object would
   * be last edit's diff for as long as it stayed selected. A path is looked up in
   * whatever arrived most recently, which is what keeps the view live.
   */
  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined);

  const socket = useSharedSessionSocket();
  const files = socket.fileChanges;
  const connected = socket.connected;
  const cliOnline = socket.online;

  // The whole session rather than just its workspace: the device panel in the
  // sidebar names the machine and its version too.
  useEffect(() => {
    void (async () => {
      try {
        setSession(await readSession(sessionId));
      } catch {
        // Ignore. The panel is a summary, so a failed read leaves it out rather than
        // taking the diff on screen down with it.
      }
    })();
  }, [sessionId]);

  // Asking the server to describe the session again is what brings the changed
  // files in, since they are replayed on attach. The socket is shared and stays
  // open, so this is the whole cost of arriving here.
  useEffect(() => {
    socket.reattach();
  }, [socket.reattach]);

  const selectedFile = files.find((file) => file.path === selectedPath);

  // Something has to be on screen: opening the list with nothing selected would
  // show the empty prompt next to a sidebar full of files, and a file that stopped
  // being changed leaves a selection pointing at nothing.
  useEffect(() => {
    if (files.length === 0) {
      setSelectedPath(undefined);
      return;
    }

    if (selectedPath !== undefined && files.some((file) => file.path === selectedPath)) {
      return;
    }

    setSelectedPath(files[0]?.path);
  }, [files, selectedPath]);

  const handleSelectFile = useCallback((file: FileChange) => {
    setSelectedPath(file.path);
    setMenuOpen(false);
  }, []);

  /**
   * Ends the session on the paired machine before the browser forgets it.
   *
   * The same pair of calls the conversation's panel makes: the agent runs there, so
   * clearing local state alone would leave a terminal waiting for a browser that
   * already left.
   */
  const disconnect = (): void => {
    socket.disconnect();
    onSessionLost();
  };

  /**
   * What the body shows instead of a diff, or undefined when there is one to show.
   *
   * Read once for the whole screen rather than wrapped around the columns, because
   * the sidebar has nothing to list in any of these cases and a file list beside
   * "device is offline" would be a list of what used to be changed.
   */
  const notice = !connected ? (
    <div className="fc-empty">
      <span className="pulse-dot" />
      <p className="muted">Connecting to device…</p>
    </div>
  ) : !cliOnline ? (
    <div className="fc-empty">
      <svg
        width="32"
        height="32"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--muted)"
        strokeWidth="1.5"
      >
        <line x1="1" y1="1" x2="23" y2="23" />
        <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
        <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
        <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
        <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
        <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
        <line x1="12" y1="20" x2="12.01" y2="20" />
      </svg>
      <p className="muted">Device is offline.</p>
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
  ) : undefined;

  // The same shell as the conversation, down to the class names: one sidebar beside
  // one main column, the same header height, the same drawer below md. Built out of
  // its own markup, this screen drifted from the one it sits next to, and moving
  // between them looked like arriving somewhere else. See ADR-007.
  return (
    <div className={`layout ${sidebarOpen ? '' : 'sidebar-closed'} ${menuOpen ? 'menu-open' : ''}`}>
      <div
        className="layout-overlay"
        onClick={() => {
          setMenuOpen(false);
        }}
      />

      <aside className="sidebar">
        <nav aria-label="Changed files">
          <div className="sidebar-head">
            <SidebarBrand />
            <div className="sidebar-head-actions">
              {files.length > 0 && (
                <span className="fc-sidebar-count">
                  {files.length} file{files.length !== 1 ? 's' : ''}
                </span>
              )}
              <button
                type="button"
                className="btn-toggle-sidebar"
                onClick={dismissSidebar}
                title="Hide sidebar"
                aria-label="Hide sidebar"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect width="18" height="18" x="3" y="3" rx="2" />
                  <path d="M9 3v18" />
                </svg>
              </button>
            </div>
          </div>

          {files.length === 0 ? (
            <div className="empty-conversations">
              <p className="muted padded">No changed files.</p>
            </div>
          ) : (
            <ul className="conversation-items" role="listbox" aria-label="Changed files">
              {files.map((file) => {
                const stats = diffStats(file.diff);
                const selected = selectedFile?.path === file.path;

                return (
                  <li
                    key={file.path}
                    className="conversation-item-wrapper"
                    role="option"
                    aria-selected={selected}
                  >
                    <button
                      type="button"
                      className={`conversation-item fc-file-row ${selected ? 'active' : ''}`}
                      onClick={() => {
                        handleSelectFile(file);
                      }}
                    >
                      <span className="item-icon">{fileIcon(file.status)}</span>
                      <span className="item-text">
                        <span className="item-title">{fileName(file.path)}</span>
                        <span className="item-meta">{fileDir(file.path) || file.status}</span>
                      </span>
                      <span className="fc-file-stats">
                        {stats.added > 0 && <span className="fc-stat-add">+{stats.added}</span>}
                        {stats.deleted > 0 && <span className="fc-stat-del">-{stats.deleted}</span>}
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
          )}
        </nav>

        {session !== undefined && (
          <div className="device-wrapper">
            {/* The notification switch is deliberately not here. It belongs beside
                the asks it raises, and those are answered in the conversation. */}
            <DevicePanel session={{ ...session, online: cliOnline }} onDisconnect={disconnect} />
          </div>
        )}
      </aside>

      <main className="main">
        <header className="main-head">
          <div className="main-head-title">
            {!sidebarOpen && (
              <button
                type="button"
                className="btn-toggle-sidebar btn-toggle-sidebar-wide"
                onClick={() => {
                  setSidebarOpen(true);
                }}
                title="Show sidebar"
                aria-label="Show sidebar"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect width="18" height="18" x="3" y="3" rx="2" />
                  <path d="M9 3v18" />
                </svg>
              </button>
            )}
            <button
              type="button"
              className="menu-button ghost"
              onClick={() => {
                setMenuOpen(!menuOpen);
              }}
              aria-label="Toggle menu"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect width="18" height="18" x="3" y="3" rx="2" />
                <path d="M9 3v18" />
              </svg>
            </button>
            {/* The screen's name rather than the open file's path. The bar below
                already names the file, with its icon and status beside it, and
                carrying the path here too put it on screen twice. */}
            <h1>Changed Files</h1>
            {/* The workspace is named in the device panel in the sidebar now, so
                repeating it here would be the same duplication the path had. */}
          </div>
          <div className="main-head-controls">
            <ViewToggle view="file-changes" onToggle={onBack} />
            <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          </div>
        </header>

        {notice ?? (
          <div className="fc-content">
            {selectedFile !== undefined && (
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
                  {selectedFile.diff !== undefined ? (
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
            )}
          </div>
        )}
      </main>
    </div>
  );
}
