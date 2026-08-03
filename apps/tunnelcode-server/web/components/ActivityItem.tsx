import { useState } from 'react';
import type { Activity } from '../api.js';

interface ActivityItemProps {
  activity: Activity;
  /** The workspace path of the current session, used to shorten paths. */
  workspace: string | undefined;
}

/**
 * One thing the engine did: a file it read or wrote, a command it ran.
 *
 * The tool and what it acted on are always on screen. Its output is behind a tap,
 * because a command prints more than the whole conversation around it and a
 * transcript that pastes it inline stops being readable on a phone. See ADR-024.
 */
export function ActivityItem({ activity, workspace }: ActivityItemProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);

  // Checked by type rather than against undefined: the transcript endpoint returns
  // the stored row, whose empty columns are null, and a null here reached .split()
  // and took the whole page down with it.
  let displayTarget = typeof activity.target === 'string' ? activity.target : undefined;

  if (displayTarget !== undefined && workspace !== undefined) {
    // The workspace is where every path in a transcript starts, so naming it says
    // nothing: what is left is already relative to it. Dropped rather than replaced
    // with a prefix, because the leading marker was as much to read as the folder
    // name it stood in front of. Done everywhere in the string, since a shell
    // command carries paths inside it rather than as the whole of it.
    displayTarget = displayTarget.split(`${workspace}/`).join('');
    // The workspace on its own has no name left to show, so it stays a dot.
    displayTarget = displayTarget.split(workspace).join('.');
  }

  const hasOutput = typeof activity.output === 'string' && activity.output.length > 0;
  const reason = typeof activity.reason === 'string' ? activity.reason : undefined;

  return (
    <div className="activity-pill-wrapper">
      <div className={`activity-container ${activity.blocked ? 'activity-blocked' : ''}`}>
        <p
          className="activity"
          onClick={
            hasOutput
              ? () => {
                  setExpanded(!expanded);
                }
              : undefined
          }
          style={{ cursor: hasOutput ? 'pointer' : 'default' }}
        >
          <span className="activity-tool">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
            </svg>
            <span>{activity.tool}</span>
          </span>
          {/* Said in words rather than by colour alone: a call that
              never ran must not read like one that did. */}
          {activity.blocked === true && <span className="activity-blocked-label">blocked</span>}
          {displayTarget !== undefined && (
            <span className="activity-target mono" title={displayTarget}>
              {displayTarget}
            </span>
          )}
          {reason !== undefined && <span className="activity-target">{reason}</span>}
          {hasOutput && (
            <span className="activity-toggle-icon">
              {expanded ? (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="18 15 12 9 6 15"></polyline>
                </svg>
              ) : (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              )}
            </span>
          )}
        </p>
        {expanded && hasOutput && (
          <div className="activity-output-container">
            <pre className="activity-output-content">{activity.output}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
