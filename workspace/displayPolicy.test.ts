import { expect, test } from "bun:test";
import { DESKTOP_SCREEN_LIMITS, parseDesktopResolution, validateDesktopScreen, withDesktopScreen } from "./displayPolicy.ts";
import type { Profile } from "../types.ts";

test("desktop geometry accepts exact custom sizes and accepts desktop/mobile presets and rejects unsafe or coerced dimensions", () => {
  for (const screen of [{ width: 390, height: 844 }, { width: 412, height: 915 }, { width: 768, height: 1024 }, { width: 1024, height: 640 }, { width: 1473, height: 913 }, { width: 4096, height: 2160 }]) {
    expect(validateDesktopScreen(screen)).toEqual(screen);
    expect(parseDesktopResolution(`${screen.width}x${screen.height}`)).toEqual(screen);
  }
  expect(DESKTOP_SCREEN_LIMITS.maxPixels).toBe(4096 * 2160);
  expect(parseDesktopResolution(" 1473 * 913 ")).toEqual({ width: 1473, height: 913 });
  for (const value of [null, [], { width: "1473", height: 913 }, { width: 319, height: 768 }, { width: 1366, height: 199 },
    { width: 4097, height: 2160 }, { width: 4096, height: 4096 }, { width: 1473.5, height: 913 },
    { width: Infinity, height: 913 }, { width: 1473, height: 913, scale: 1 }, "1473x913\n", "1473x913<script>", "1e3x913"]) {
    expect(() => parseDesktopResolution(value)).toThrow();
  }
});

test("Firefox stopped geometry patch changes only screen geometry and leaves the input immutable", () => {
  const profile = { engine: "firefox", screenWidth: 1920, screenHeight: 1080, fingerprintSeed: 42,
    ua: "desktop-user-agent", username: "account", password: "local-secret", cookies: [{ name: "session", value: "private" }],
    firefox: { version: 1, runtimeVersion: "fixture", config: { "navigator.userAgent": "desktop-user-agent", timezone: "UTC", fonts: ["Segoe UI"],
      "screen.width": 1920, "screen.height": 1080, "screen.availWidth": 1920, "screen.availHeight": 1040,
      "window.innerWidth": 1440, "window.innerHeight": 900, "window.outerWidth": 1440, "window.outerHeight": 940,
      "window.screenX": 15, "window.screenY": 20, "screen.availLeft": 3, "screen.availTop": 40, "screen.colorDepth": 24 } } } as unknown as Profile;
  const saved = structuredClone(profile), changed = withDesktopScreen(profile, { width: 1473, height: 913 });
  expect(profile).toEqual(saved);
  expect(changed.screenWidth).toBe(1473); expect(changed.screenHeight).toBe(913);
  expect(changed.firefox?.config).toMatchObject({ "screen.width": 1473, "screen.height": 913, "screen.availWidth": 1473, "screen.availHeight": 913,
    "window.innerWidth": 1473, "window.innerHeight": 913, "window.outerWidth": 1473, "window.outerHeight": 913,
    "window.screenX": 0, "window.screenY": 0, "screen.availLeft": 0, "screen.availTop": 0 });
  for (const key of ["navigator.userAgent", "timezone", "fonts", "screen.colorDepth"]) expect(changed.firefox?.config[key]).toEqual(saved.firefox?.config[key]);
  expect({ ...changed, screenWidth: saved.screenWidth, screenHeight: saved.screenHeight, firefox: saved.firefox } as unknown).toEqual(saved);
});
