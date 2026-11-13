/** Saved viewport geometry for desktop and mobile-sized profile views. */
import type { Profile } from "../types.ts";

export const DESKTOP_SCREEN_LIMITS = Object.freeze({ minWidth: 320, maxWidth: 4096, minHeight: 200, maxHeight: 4096, maxPixels: 4096 * 2160 });
export interface DesktopScreen { width: number; height: number; }

export function validateDesktopScreen(value: unknown): DesktopScreen {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Desktop screen requires width and height");
  const screen = value as Record<string, unknown>;
  if (Object.keys(screen).some(key => key !== "width" && key !== "height")
    || !Number.isSafeInteger(screen.width) || !Number.isSafeInteger(screen.height)
    || Number(screen.width) < DESKTOP_SCREEN_LIMITS.minWidth || Number(screen.width) > DESKTOP_SCREEN_LIMITS.maxWidth
    || Number(screen.height) < DESKTOP_SCREEN_LIMITS.minHeight || Number(screen.height) > DESKTOP_SCREEN_LIMITS.maxHeight
    || Number(screen.width) * Number(screen.height) > DESKTOP_SCREEN_LIMITS.maxPixels) {
    throw new Error("Desktop screen must use integer width 320–4096 and height 200–4096 within the live-view pixel budget");
  }
  return { width: screen.width as number, height: screen.height as number };
}

export function parseDesktopResolution(value: unknown): DesktopScreen {
  if (typeof value !== "string") return validateDesktopScreen(value);
  if (value.length > 40 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Desktop resolution is invalid");
  const match = /^\s*(\d{3,4})\s*[xX*]\s*(\d{3,4})\s*$/.exec(value);
  if (!match) throw new Error("Desktop resolution must contain width x height");
  return validateDesktopScreen({ width: Number(match[1]), height: Number(match[2]) });
}

/** Launch validates saved dimensions without changing any profile identity. */
export function validateDesktopProfile(profile: Profile): DesktopScreen {
  const screen = validateDesktopScreen({ width: profile.screenWidth, height: profile.screenHeight });
  if (profile.engine === "firefox") {
    const config = profile.firefox?.config;
    if (!config || config["screen.width"] !== screen.width || config["screen.height"] !== screen.height) {
      throw new Error("Saved Firefox screen dimensions differ; update the stopped profile before starting");
    }
  }
  return screen;
}

/** Explicit creation/stopped-edit boundary; never regenerate identity inputs. */
export function withDesktopScreen(profile: Profile, value: DesktopScreen): Profile {
  const { width, height } = validateDesktopScreen(value);
  if (profile.engine !== "firefox") return { ...profile, screenWidth: width, screenHeight: height };
  if (!profile.firefox) throw new Error("Firefox profile is missing its saved configuration");
  const origin = Object.fromEntries(["window.screenX", "window.screenY", "screen.availLeft", "screen.availTop"]
    .filter(key => Object.hasOwn(profile.firefox!.config, key)).map(key => [key, 0]));
  return { ...profile, screenWidth: width, screenHeight: height, firefox: { ...profile.firefox, config: {
    ...profile.firefox.config,
    ...origin,
    "screen.width": width, "screen.height": height, "screen.availWidth": width, "screen.availHeight": height,
    "window.innerWidth": width, "window.innerHeight": height, "window.outerWidth": width, "window.outerHeight": height,
  } } };
}
