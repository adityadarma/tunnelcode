import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import jsQR from 'jsqr';
import { pairingCodeFromQr } from '../pairing-code-from-qr.js';

const SCAN_INTERVAL_MS = 100;

/**
 * Side of the square the decoder actually looks at, in pixels.
 *
 * Decoding cost scales with pixel count, and a phone camera hands over frames far
 * larger than a QR code needs: at 1080p a full frame is over two million pixels
 * per attempt, which is what made scanning feel slow. 480 still resolves the
 * modules of a code held in front of the camera.
 */
const SCAN_SIZE = 480;

interface QrScannerModalProps {
  onScanned: (code: string) => void;
  onClose: () => void;
}

/**
 * Turns a getUserMedia rejection into something a reader can act on.
 *
 * A denied permission and a missing camera need different answers from the user,
 * and an insecure origin is neither: the browser withholds the camera entirely
 * over plain http, which no amount of retrying changes.
 */
function describeCameraError(error: unknown): string {
  if (!window.isSecureContext) {
    return 'The camera needs a secure connection. Open this page over HTTPS, or type the code instead.';
  }

  const name = error instanceof Error ? error.name : '';

  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera access was blocked. Allow it in your browser settings, or type the code instead.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No camera was found on this device. Type the code instead.';
  }
  if (name === 'NotReadableError') {
    return 'The camera is in use by another app. Close it and try again.';
  }

  return 'The camera could not be started. Type the code instead.';
}

/**
 * Camera QR scanner for the pairing code.
 *
 * Decoding runs here rather than through BarcodeDetector, which iOS Safari does
 * not implement: a pairing screen that only scans on some phones is not worth the
 * branch. Frames are sampled on a timer instead of every animation frame, because
 * a QR code held in front of a camera does not move fast and decoding each frame
 * flattens a phone battery for nothing.
 */
export function QrScannerModal({ onScanned, onClose }: QrScannerModalProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  // A QR that is not a pairing code is reported beside a live camera rather than in
  // place of it, so the next code can be scanned without reopening the scanner.
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [scanning, setScanning] = useState(false);

  // Held in a ref so the scan loop reads the current callbacks without being torn
  // down and restarted, which would stop and reopen the camera mid-scan.
  const onScannedRef = useRef(onScanned);
  onScannedRef.current = onScanned;

  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    // Held on an object rather than in a plain local: the flag is only ever set by
    // the cleanup below, which the compiler cannot see running, so a local would be
    // narrowed to false and the check compiled away.
    const state = { cancelled: false };
    const canvas = document.createElement('canvas');

    const readFrame = (): void => {
      const video = videoRef.current;

      if (video === null || video.readyState < video.HAVE_CURRENT_DATA) {
        return;
      }

      const videoWidth = video.videoWidth;
      const videoHeight = video.videoHeight;

      if (videoWidth === 0 || videoHeight === 0) {
        return;
      }

      const context = canvas.getContext('2d', { willReadFrequently: true });

      if (context === null) {
        return;
      }

      // Only the centre square is sampled, matching the reticle: a code held
      // outside it is not what the user is aiming, and cropping keeps the decoded
      // area small without throwing away the resolution the code sits at.
      const side = Math.min(videoWidth, videoHeight);
      const sourceX = (videoWidth - side) / 2;
      const sourceY = (videoHeight - side) / 2;
      const size = Math.min(SCAN_SIZE, side);

      canvas.width = size;
      canvas.height = size;

      context.drawImage(video, sourceX, sourceY, side, side, 0, 0, size, size);
      const frame = context.getImageData(0, 0, size, size);
      // attemptBoth also reads a code shown light-on-dark, which a terminal on a
      // dark theme prints. Cropping paid for the second pass.
      const result = jsQR(frame.data, size, size, { inversionAttempts: 'attemptBoth' });

      if (result === null) {
        return;
      }

      const code = pairingCodeFromQr(result.data);

      if (code === undefined) {
        setNotice('That QR code is not a TunnelCode pairing code.');
        return;
      }

      // Stopped here rather than left to cleanup, so a second frame of the same
      // code cannot start pairing twice.
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }

      onScannedRef.current(code);
    };

    void (async () => {
      // Typed as always present, but absent in practice on a page served over
      // plain http and in jsdom, so the call is guarded rather than trusted.
      const media = navigator.mediaDevices as MediaDevices | undefined;

      if (media === undefined) {
        setError(describeCameraError(undefined));
        return;
      }

      try {
        // The back camera is the one pointed at a terminal screen. A phone without
        // one falls back on its own rather than failing the request.
        // 720p is asked for rather than whatever the camera prefers: a larger frame
        // only costs more to copy out of, since decoding crops to the centre anyway.
        stream = await media.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
      } catch (cause) {
        setError(describeCameraError(cause));
        return;
      }

      if (state.cancelled) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        return;
      }

      const video = videoRef.current;

      if (video === null) {
        return;
      }

      video.srcObject = stream;
      await video.play().catch(() => undefined);
      setScanning(true);
      timer = setInterval(readFrame, SCAN_INTERVAL_MS);
    })();

    return () => {
      state.cancelled = true;

      if (timer !== undefined) {
        clearInterval(timer);
      }

      if (stream !== undefined) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
      }
    };
  }, []);

  const stopAndClose = useCallback((): void => {
    onClose();
  }, [onClose]);

  return createPortal(
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="qr-scanner-title"
    >
      <section className="modal-card">
        <div className="modal-header">
          <h3 id="qr-scanner-title">Scan pairing QR</h3>
          <button
            ref={closeButtonRef}
            type="button"
            className="btn-modal-close"
            onClick={stopAndClose}
            aria-label="Close scanner"
          >
            ✕
          </button>
        </div>

        <div className="modal-body">
          {error === undefined ? (
            <>
              <div className="qr-scanner-frame">
                <video ref={videoRef} className="qr-scanner-video" muted playsInline />
                <div className="qr-scanner-reticle" />
              </div>
              {notice === undefined ? (
                <p className="muted qr-scanner-hint">
                  {scanning
                    ? 'Point the camera at the QR code in your terminal.'
                    : 'Starting the camera…'}
                </p>
              ) : (
                <p role="alert" className="error qr-scanner-hint">
                  {notice}
                </p>
              )}
            </>
          ) : (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn-modal-cancel" onClick={stopAndClose}>
            Cancel
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
