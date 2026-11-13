/** Effective browser content dimensions, after launch-time window fitting. */
export interface LaunchViewport { width: number; height: number; }

/** Saved monitor dimensions have stricter minimums than their available content area. */
export function validateLaunchViewport(value: unknown): LaunchViewport {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid launch content viewport");
  const viewport = value as Record<string, unknown>;
  if (Object.keys(viewport).some(key => key !== "width" && key !== "height")
    || !Number.isSafeInteger(viewport.width) || !Number.isSafeInteger(viewport.height)
    || Number(viewport.width) < 1 || Number(viewport.height) < 1) {
    throw new Error("Invalid launch content viewport");
  }
  return { width: viewport.width as number, height: viewport.height as number };
}

/** Capture limits apply only to Live attachment, never to ordinary profile startup. */
export function validateLiveViewport(value: unknown): LaunchViewport {
  const viewport = validateLaunchViewport(value);
  if (viewport.width > 4096 || viewport.height > 4096 || viewport.width * viewport.height > 4096 * 2160) {
    throw new Error("Browser content viewport exceeds the live-view pixel budget");
  }
  return viewport;
}

/** A legacy running browser has no trustworthy historical window-fit snapshot. */
export class LaunchViewportUnavailableError extends Error {
  constructor() {
    super("Stop and restart this profile to prepare its browser viewport before opening the Live workspace");
    this.name = "LaunchViewportUnavailableError";
  }
}
