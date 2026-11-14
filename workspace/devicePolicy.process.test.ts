import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNewProfile } from "../create.ts";
import { ProfileStore } from "../store.ts";
import { ProcessManager, type WorkspaceIdentityStore } from "./processManager.ts";
import type { LaunchStartOptions } from "../launcher.ts";
import { WorkspacePolicyStore } from "./profileStore.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture(cached = true) {
  const root = mkdtempSync(join(tmpdir(), "gamebrowser-device-policy-"));
  const backing = new ProfileStore(join(root, "profiles.sqlite"));
  const profile = buildNewProfile({ name: "Cloud identity", engine: "chromium", proxy: { type: "http", host: "proxy.example.test", port: "8080", user: "user", pass: "private" } }, () => false);
  if (cached) backing.upsertProfile(profile);
  let authorized = true, visible = true, blocked = false, writes = 0;
  let holdStart: (() => Promise<void>) | undefined;
  const calls: Array<{ id: string; urls: string[]; options: LaunchStartOptions }> = [];
  const store: WorkspaceIdentityStore = {
    getProfile: id => backing.getProfile(id), listProfiles: () => backing.listProfiles(),
    getLaunch: id => backing.getLaunch(id), listLaunches: () => backing.listLaunches(),
    upsertProfiles() { writes++; throw new Error("identity must remain read-only"); },
    deleteProfile() { writes++; throw new Error("identity must remain read-only"); },
  };
  const manager = new ProcessManager({ store, stateRoot: root, readOnlyIdentity: true,
    externalProfiles: () => visible ? [{ id: profile.id, name: profile.name, engine: "chromium", screenWidth: profile.screenWidth, screenHeight: profile.screenHeight }] : [],
    authorize: () => { if (!authorized) throw new Error("Cloud access changed"); },
    launcher: { async start() { throw new Error("use certified Cloud lifecycle"); }, async stop() { return true; }, profileDeletionBlocked: () => blocked },
    warmProcessService: async () => true, monitorFactory: () => ({ start() {}, dispose() {} }),
    lifecycle: {
      async start(id, options, urls) {
        await holdStart?.(); calls.push({ id, options, urls });
        backing.recordLaunch({ profileId: id, engine: "chromium", pid: 1001, debugPort: 9222, ws: "ws://127.0.0.1:9222/devtools/browser/device-policy", startedAt: Date.now(), headless: true });
      },
      async stop(id) { backing.clearLaunch(id); return true; },
    },
  });
  cleanups.push(() => { manager.dispose(); backing.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, backing, profile, manager, calls, writes: () => writes,
    authorize(value: boolean) { authorized = value; }, visible(value: boolean) { visible = value; }, block(value: boolean) { blocked = value; },
    holdStart(value: () => Promise<void>) { holdStart = value; } };
}

test("readonly Cloud device policies use the manager's live policy store without changing identity", async () => {
  const f = fixture(), before = f.backing.getProfile(f.profile.id);
  expect(f.manager.canEditProfile(f.profile.id)).toBe(false);
  f.manager.setDevicePolicy(f.profile.id, { ramMb: 4096, heapMb: 768, explicitHeap: true, urls: ["https://example.test/board"], networkMode: "system", budgetAction: "notify" });
  // A later update must retain the same manager's prior choices instead of overwriting them from a stale second store.
  const view = f.manager.setDevicePolicy(f.profile.id, { budgetAction: "pause-sync" });
  expect(view).toMatchObject({ ramMb: 4096, heapMb: 768, networkMode: "system", urls: ["https://example.test/board"], budgetAction: "pause-sync" });
  expect(f.manager.getResourceLimits(f.profile.id)).toEqual({ v8OldSpaceMb: 768, deviceScaleFactor: 1 });
  expect(new WorkspacePolicyStore(f.root).get(f.profile.id)).toMatchObject({ ramMb: 4096, heapMb: 768, explicitHeap: true, networkMode: "system", budgetAction: "pause-sync" });
  await f.manager.start(f.profile.id);
  expect(f.calls[0]).toMatchObject({ urls: ["https://example.test/board"], options: { networkMode: "system", resourceLimits: { v8OldSpaceMb: 768, deviceScaleFactor: 1 } } });
  expect(f.backing.getProfile(f.profile.id)).toEqual(before);
  expect(f.writes()).toBe(0);
  expect(() => f.manager.setPolicy(f.profile.id, { ramMb: 2048 })).toThrow("stop the profile");
});

test("device policy permits uncached Cloud summaries without creating identity or proxy credentials", () => {
  const f = fixture(false);
  expect(f.manager.setDevicePolicy(f.profile.id, { ramMb: 3072, heapMb: 512, explicitHeap: false, urls: ["https://example.test/"], networkMode: "direct" })).toMatchObject({ ramMb: 3072, heapMb: 512, networkMode: "direct" });
  expect(f.backing.listProfiles()).toEqual([]);
  expect(f.writes()).toBe(0);
  expect(() => f.manager.setDevicePolicy(f.profile.id, { networkMode: "proxy" })).toThrow("Open this Cloud profile once");
  expect(f.manager.getProfile(f.profile.id)?.networkMode).toBe("direct");
});

test("device policies validate every field atomically and retain credential-free local settings", () => {
  const f = fixture();
  f.manager.setDevicePolicy(f.profile.id, { ramMb: 4096, heapMb: 512, networkMode: "proxy" });
  const file = join(f.root, "workspace", "policies.json"), previous = readFileSync(file, "utf8");
  for (const value of [{ ramMb: 1 }, { heapMb: 8192 }, { urls: ["https://example.test/?session=secret"] }, { networkMode: "unknown" }, { explicitHeap: "yes" }, { manual: false }, { proxy: "http://user:private@other.example:80" }]) {
    expect(() => f.manager.setDevicePolicy(f.profile.id, value as any)).toThrow();
    expect(readFileSync(file, "utf8")).toBe(previous);
  }
  expect(previous).not.toContain("private");
  expect(previous).not.toContain("proxy.example.test");
  expect(f.writes()).toBe(0);
});

test("device policies require live authorization, current membership, stopped ownership and open start gates", async () => {
  const f = fixture();
  f.authorize(false);
  expect(() => f.manager.setDevicePolicy(f.profile.id, { ramMb: 4096 })).toThrow("Cloud access changed");
  f.authorize(true); f.visible(false);
  expect(() => f.manager.setDevicePolicy(f.profile.id, { ramMb: 4096 })).toThrow("current workspace");
  f.visible(true); f.block(true);
  expect(() => f.manager.setDevicePolicy(f.profile.id, { ramMb: 4096 })).toThrow("finish its lifecycle");
  f.block(false);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); f.holdStart(() => held);
  const starting = f.manager.start(f.profile.id);
  expect(() => f.manager.setDevicePolicy(f.profile.id, { ramMb: 4096 })).toThrow("finish its lifecycle");
  release(); await starting;
  expect(() => f.manager.setDevicePolicy(f.profile.id, { ramMb: 4096 })).toThrow("finish its lifecycle");
  const stopping = f.manager.stop(f.profile.id);
  expect(() => f.manager.setDevicePolicy(f.profile.id, { ramMb: 4096 })).toThrow("finish its lifecycle");
  await stopping;
  expect(f.manager.setDevicePolicy(f.profile.id, { heapMb: 768, explicitHeap: false }).heapMb).toBe(768);
  expect(f.manager.getResourceLimits(f.profile.id)).toBeUndefined();
  f.manager.beginShutdown();
  expect(() => f.manager.setDevicePolicy(f.profile.id, { ramMb: 4096 })).toThrow("finish its lifecycle");
  expect(f.writes()).toBe(0);
});
