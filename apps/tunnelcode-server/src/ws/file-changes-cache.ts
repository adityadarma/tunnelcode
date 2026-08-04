/**
 * Last known file changes per device, cached in memory so a browser that attaches
 * after the CLI already sent its state gets it immediately without waiting for the
 * next poll. Keyed by device id, cleared when the device disconnects.
 */
export const fileChangesCache = new Map<string, { path: string; status: string; diff?: string | undefined }[]>();
