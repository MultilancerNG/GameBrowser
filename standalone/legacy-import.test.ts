import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { runCloakpitImportCommand } from "./legacy-import.ts";

test("native import passes explicit destination and profile root to the certified migration library", async () => {
  const calls: unknown[] = [];
  const result = await runCloakpitImportCommand(["--source", "old-state", "--state-root", "new-gamebrowser-state", "--cloakpit-profile-root", "old-browser-data"], async (source, destination, options) => {
    calls.push({ source, destination, options });
    return { status: "migrated", profileCount: 3 };
  });
  expect(calls).toEqual([expect.objectContaining({ source: "old-state", destination: expect.objectContaining({ root: resolve("new-gamebrowser-state") }), options: { profileRoot: "old-browser-data" } })]);
  expect(result).toMatchObject({ ok: true });
  expect(result.message).toContain("Imported 3 Cloakpit profile(s)");
  expect(result.message).toContain("same Windows machine and account");
});

test("native import preserves rejection and missing-source details without claiming success", async () => {
  const failed = await runCloakpitImportCommand(["--source", "old-state", "--state-root", "new-state"], async () => { throw new Error("destination already contains profiles"); });
  expect(failed.ok).toBe(false);
  expect(failed.message).toContain("destination already contains profiles");
  expect(failed.message).toContain("Windows DPAPI");
  const absent = await runCloakpitImportCommand(["--source", "absent", "--state-root", "new-state"], async () => ({ status: "not_found", profileCount: 0 }));
  expect(absent.ok).toBe(false);
  expect(absent.message).toContain("No profiles.sqlite was found");
});
