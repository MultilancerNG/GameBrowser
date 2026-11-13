import { expect, test } from "bun:test";
import { VIEWPORT_PRESETS } from "./viewport-presets.ts";
import { buildNewProfile } from "../create.ts";
import { parseResolution } from "../fingerprint.ts";

test("desktop and mobile presets pass the existing profile creation screen path", () => {
  for (const preset of VIEWPORT_PRESETS) {
    const dimensions = parseResolution(preset.value);
    const profile = buildNewProfile({ screen: preset.value, engine: "chromium" }, () => false);
    expect(profile.screenWidth).toBe(dimensions.width);
    expect(profile.screenHeight).toBe(dimensions.height);
    expect(profile.fingerprintSeed).toBeGreaterThan(0);
  }
});
