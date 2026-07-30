import type { SessionDetail } from '../api.js';

interface DevicePanelProps {
  session: SessionDetail;
  onDisconnect: () => void;
}

/**
 * Device summary.
 *
 * Offline is shown plainly because it explains why sending is blocked: the
 * agent runs on the paired machine, so nothing can be asked while its CLI is
 * stopped.
 */
export function DevicePanel({ session, onDisconnect }: DevicePanelProps): React.JSX.Element {
  return (
    <section className="device-panel" aria-label="Device">
      <div className="device-card-head">
        <div className="device-card-head-title">
          <span className={`status-dot ${session.online ? 'online' : 'offline'}`} />
          <span className="device-card-label">Device Info</span>
        </div>
        <span className={session.online ? 'badge online' : 'badge offline'}>
          {session.online ? 'online' : 'offline'}
        </span>
      </div>

      <dl>
        <div>
          <dt>Device</dt>
          <dd title={session.deviceName}>{session.deviceName}</dd>
        </div>
        <div>
          <dt>Workspace</dt>
          <dd className="mono" title={session.workspace}>
            {session.workspace}
          </dd>
        </div>
        <div>
          <dt>Engine</dt>
          <dd>{session.engine}</dd>
        </div>
      </dl>

      <button type="button" className="btn-disconnect" onClick={onDisconnect}>
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
        >
          <path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path>
          <line x1="12" y1="2" x2="12" y2="12"></line>
        </svg>
        <span>Disconnect</span>
      </button>
    </section>
  );
}
