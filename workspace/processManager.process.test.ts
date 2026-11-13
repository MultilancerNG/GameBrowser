import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessManager } from "./processManager.ts";
import { normalizeWorkspacePolicy, parseWorkspaceProxy, WorkspacePolicyStore } from "./profileStore.ts";
import { ProfileStore } from "../store.ts";
import type { LaunchStartOptions } from "../launcher.ts";
import type { LaunchInfo } from "../types.ts";
import { launchGeneration, type ResourceMetrics, type ResourceMonitorOptions } from "./resourceMonitor.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture(warmProcessService: () => Promise<boolean> = async () => true) {
  const directory = mkdtempSync(join(tmpdir(), "stakemode-process-"));
  const store = new ProfileStore(join(directory, "profiles.sqlite"));
  let monitor!: ResourceMonitorOptions;
  const calls: Array<{ id: string; urls: string[]; options: LaunchStartOptions }> = [];
  const stopCalls: Array<{ id: string; expected: unknown; force: boolean }> = [];
  const launcher = {
    async start(id: string, urls: string[] = [], options: LaunchStartOptions = {}) {
      calls.push({ id, urls, options });
      store.recordLaunch({ profileId: id, engine: store.getProfile(id)?.engine, pid: 1001 + calls.length, debugPort: 9222 + calls.length,
        ws: "ws://127.0.0.1:9222/devtools/browser/test", startedAt: Date.now(), binaryPath: "C:\\StakeMode\\chrome.exe",
        userDataDir: `C:\\StakeMode\\Profiles\\${id}`, headless: options.headless });
      return { ws: "ws://127.0.0.1:9222/devtools/browser/test", port: 9222 };
    },
    async stop(id: string, expected?: unknown) { stopCalls.push({ id, expected, force: false }); store.clearLaunch(id); return true; },
    async forceStop(id: string, expected?: unknown) { stopCalls.push({ id, expected, force: true }); store.clearLaunch(id); return true; },
  };
  const manager = new ProcessManager({ launcher, store, stateRoot: directory, warmProcessService, monitorFactory(options) { monitor = options; return { start() {}, dispose() {} }; } });
  cleanups.push(() => { manager.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, manager, store, calls, stopCalls, launcher, emit(rows: ResourceMetrics[]) { monitor.onMetrics(rows); } };
}

test("first native launches await one idle service warmup and zero-profile startup creates no helper", async () => {
  let warmed = 0, release!: (ready: boolean) => void;
  const blocked = new Promise<boolean>(done => { release = done; });
  const f = fixture(async () => { warmed++; return blocked; });
  await Bun.sleep(0); expect(warmed).toBe(0);
  const profiles = await f.manager.bulkCreate({ count: 4 });
  const opening = profiles.map(profile => f.manager.start(profile.id));
  await Bun.sleep(0); expect(warmed).toBe(1); expect(f.calls).toHaveLength(0);
  expect(profiles.every(profile => !f.manager.canEditProfile(profile.id))).toBe(true);
  release(true); await Promise.all(opening); expect(f.calls).toHaveLength(4);
  await f.manager.stop(profiles[0]!.id); await f.manager.start(profiles[0]!.id); expect(warmed).toBe(1);
});
test("unknown native warmup prevents all initial spawns and permits a later explicit recovery", async () => {
  let available = false, warmed = 0;
  const f = fixture(async () => { warmed++; return available; });
  const profiles = await f.manager.bulkCreate({ count: 4 });
  const failed = await Promise.allSettled(profiles.map(profile => f.manager.start(profile.id)));
  expect(failed.every(result => result.status === "rejected")).toBe(true); expect(warmed).toBe(1);
  expect(f.calls).toHaveLength(0); expect(f.store.listLaunches()).toEqual([]);
  expect(f.manager.list().every(profile => profile.manual && profile.state === "error")).toBe(true);
  available = true; await f.manager.start(profiles[0]!.id); expect(warmed).toBe(2); expect(f.calls).toHaveLength(1);
});

test("bulk creation isolates persisted identities and never exposes proxy/account credentials", async () => {
  const f = fixture();
  const profiles = await f.manager.bulkCreate({ count: 3, prefix: "Workspace", proxies: ["socks5://operator:topsecret@example.test:1080"], ramMb: 1024, heapMb: 256,
    urls: ["https://example.test/play"], resolutions: ["1366x768", { width: 1920, height: 1080 }] });
  expect(new Set(profiles.map((profile) => profile.id)).size).toBe(3);
  expect(new Set(f.store.listProfiles().map((profile) => profile.fingerprintSeed)).size).toBe(3);
  expect(profiles.map((profile) => profile.screenWidth)).toEqual([1366, 1920, 1366]);
  expect(profiles.every((profile) => profile.manual && profile.state === "stopped")).toBe(true);
  expect(f.store.getProfile(profiles[0]!.id)?.proxy?.pass).toBe("topsecret");
  expect(JSON.stringify(f.manager.list())).not.toContain("topsecret");
  expect(JSON.stringify(f.manager.list())).not.toContain("operator");
  expect(new WorkspacePolicyStore(f.directory).get(profiles[0]!.id)).toMatchObject({ ramMb: 1024, heapMb: 256, manual: true });
});
test("bulk validation is all-or-nothing and caps profile count, proxies, and URL policy", async () => {
  const f = fixture();
  await expect(f.manager.bulkCreate({ count: 0 })).rejects.toThrow("1 to 256");
  await expect(f.manager.bulkCreate({ count: 257 })).rejects.toThrow("1 to 256");
  await expect(f.manager.bulkCreate({ count: 3, proxies: ["127.0.0.1:1080", "127.0.0.1:1081"] })).rejects.toThrow("exactly one");
  await expect(f.manager.bulkCreate({ count: 3, resolutions: ["1920x1080", "1x1"] })).rejects.toThrow();
  await expect(f.manager.bulkCreate({ count: 1, urls: ["https://user:secret@example.test/"] })).rejects.toThrow("credentials");
  await expect(f.manager.bulkCreate({ count: 1, urls: ["http://example.test/"] })).rejects.toThrow("HTTPS");
  expect(f.store.count()).toBe(0);
});
test("every desktop resolution is checked before creation, including unused list entries", async () => {
  const f = fixture();
  for (const resolutions of [["1473x913", "319x844"], ["1473x913", { width: 4097, height: 2160 }], [{ width: 1473, height: 913, mobile: true }]]) {
    await expect(f.manager.bulkCreate({ count: 1, resolutions })).rejects.toThrow();
    expect(f.store.count()).toBe(0);
  }
});
test("Firefox and Chromium persist the minimum and 4K desktop boundary without generator rounding", async () => {
  const f = fixture();
  for (const engine of ["chromium", "firefox"] as const) {
    const profiles = await f.manager.bulkCreate({ count: 2, engine, resolutions: [{ width: 1024, height: 640 }, { width: 4096, height: 2160 }] });
    expect(profiles.map(profile => [profile.screenWidth, profile.screenHeight])).toEqual([[1024, 640], [4096, 2160]]);
    if (engine === "firefox") for (const profile of profiles) expect(f.store.getProfile(profile.id)?.firefox?.config).toMatchObject({
      "screen.width": profile.screenWidth, "screen.height": profile.screenHeight, "window.innerWidth": profile.screenWidth, "window.innerHeight": profile.screenHeight,
    });
  }
});
test("both engines retain custom desktop geometry and stopped edits preserve all non-geometry identity", async () => {
  const f = fixture();
  for (const engine of ["chromium", "firefox"] as const) {
    const [created] = await f.manager.bulkCreate({ count: 1, engine, resolutions: [{ width: 1473, height: 913 }] });
    expect(created).toMatchObject({ screenWidth: 1473, screenHeight: 913 });
    let before = f.store.getProfile(created!.id)!;
    f.store.upsertProfiles([{ ...before, username: "account", password: "private", twofa: "local-only", cookies: [{ name: "session", value: "private", domain: "example.test", path: "/" }] }]);
    before = f.store.getProfile(created!.id)!;
    if (engine === "firefox") expect(before.firefox?.config).toMatchObject({ "screen.width": 1473, "screen.height": 913, "window.innerWidth": 1473, "window.innerHeight": 913 });
    f.manager.updateScreen(created!.id, { width: 2049, height: 1153 });
    const after = f.store.getProfile(created!.id)!;
    expect({ ...after, screenWidth: before.screenWidth, screenHeight: before.screenHeight, ...(engine === "firefox" ? { firefox: before.firefox } : {}) }).toEqual(before);
    if (engine === "firefox") {
      const geometry = /^(?:screen\.(?:width|height|availWidth|availHeight|availLeft|availTop)|window\.(?:innerWidth|innerHeight|outerWidth|outerHeight|screenX|screenY))$/;
      expect(Object.fromEntries(Object.entries(after.firefox!.config).filter(([key]) => !geometry.test(key))))
        .toEqual(Object.fromEntries(Object.entries(before.firefox!.config).filter(([key]) => !geometry.test(key))));
      expect(after.firefox?.config).toMatchObject({ "screen.width": 2049, "screen.height": 1153, "screen.availWidth": 2049, "screen.availHeight": 1153, "window.innerWidth": 2049, "window.innerHeight": 1153, "window.outerWidth": 2049, "window.outerHeight": 1153 });
    }
    const copied = await f.manager.copyProfile(created!.id);
    expect(copied).toMatchObject({ screenWidth: 2049, screenHeight: 1153 });
    expect(f.store.getProfile(copied.id)?.fingerprintSeed).not.toBe(before.fingerprintSeed);
    if (engine === "firefox") expect(f.store.getProfile(copied.id)?.firefox?.config).toMatchObject({ "screen.width": 2049, "screen.height": 1153, "window.innerWidth": 2049, "window.innerHeight": 1153 });
  }
});
test("desktop screen changes reject running and queued launch generations", async () => {
  const f = fixture();
  const [profile] = await f.manager.bulkCreate({ count: 1 });
  const opening = f.manager.start(profile!.id);
  expect(() => f.manager.updateScreen(profile!.id, { width: 1473, height: 913 })).toThrow("stop the profile");
  await opening;
  expect(() => f.manager.updateScreen(profile!.id, { width: 1473, height: 913 })).toThrow("stop the profile");
  await f.manager.stop(profile!.id);
  expect(f.manager.updateScreen(profile!.id, { width: 1473, height: 913 })).toMatchObject({ screenWidth: 1473, screenHeight: 913 });
});
test("mobile sizes and native Firefox chrome geometry launch without rewriting the saved identity", async () => {
  const f = fixture();
  const [chrome] = await f.manager.bulkCreate({ count: 1, resolutions: ["390x844"] });
  const original = f.store.getProfile(chrome!.id)!;
  const mobile = { ...original, ua: "Mozilla/5.0 Android Mobile" };
  f.store.upsertProfiles([mobile]);
  await f.manager.start(chrome!.id);
  expect(f.store.getProfile(chrome!.id)).toEqual(mobile); expect(f.calls).toHaveLength(1);
  const [firefox] = await f.manager.bulkCreate({ count: 1, engine: "firefox" });
  const saved = f.store.getProfile(firefox!.id)!;
  const nativeChrome = { ...saved, firefox: { ...saved.firefox!, config: { ...saved.firefox!.config, "window.innerWidth": 900 } } };
  f.store.upsertProfiles([nativeChrome]);
  await f.manager.start(firefox!.id);
  expect(f.store.getProfile(firefox!.id)).toEqual(nativeChrome); expect(f.calls).toHaveLength(2);
  await f.manager.stop(firefox!.id);
  const invalid = { ...nativeChrome, firefox: { ...nativeChrome.firefox!, config: { ...nativeChrome.firefox!.config, "screen.width": 900 } } };
  f.store.upsertProfiles([invalid]);
  expect(() => f.manager.start(firefox!.id)).toThrow("screen dimensions differ");
  expect(f.store.getProfile(firefox!.id)).toEqual(invalid); expect(f.calls).toHaveLength(2);
});
test("proxy parse failures contain no submitted credentials and accept explicit SOCKS", () => {
  expect(parseWorkspaceProxy("socks5://name:pass@example.test:1080")).toMatchObject({ type: "socks5", user: "name", pass: "pass" });
  try { parseWorkspaceProxy("unsupported://name:keepmeprivate@example.test:1080"); throw new Error("expected rejection"); }
  catch (error) { expect(String(error)).not.toContain("keepmeprivate"); expect(String(error)).toContain("Invalid proxy"); }
  expect(() => normalizeWorkspacePolicy({ heapMb: 2048, ramMb: 1024 })).toThrow("no larger");
});
test("only Chromium receives trusted V8 resource options and exact generation stops", async () => {
  const f = fixture();
  const [profile] = await f.manager.bulkCreate({ count: 1, heapMb: 768, ramMb: 2048, urls: ["https://example.test/"] });
  await f.manager.start(profile!.id);
  expect(f.calls[0]?.options).toMatchObject({ headless: true, restoreLastSession: true, resourceLimits: { v8OldSpaceMb: 768, deviceScaleFactor: 1 } });
  const launch = f.manager.getLaunch(profile!.id)!;
  expect(() => f.manager.setPolicy(profile!.id, { heapMb: 512 })).toThrow("stop the profile");
  expect(await f.manager.forceKill(profile!.id)).toBe(true);
  expect(f.stopCalls[0]).toEqual({ id: profile!.id, force: true, expected: { startedAt: launch.startedAt, debugPort: launch.debugPort } });
  const [firefox] = await f.manager.bulkCreate({ count: 1, engine: "firefox" });
  await f.manager.start(firefox!.id);
  expect(f.calls[1]?.options).not.toHaveProperty("resourceLimits");
});
test("reopening a saved query-specific tab does not append or focus the initial startup URL", async () => {
  const f = fixture();
  const [profile] = await f.manager.bulkCreate({ count: 1, urls: ["https://example.test/board"] });
  await f.manager.start(profile!.id);
  expect(f.calls[0]!.urls).toEqual(["https://example.test/board"]);
  await f.manager.stop(profile!.id);
  f.store.saveSessionBundle(profile!.id, JSON.stringify({ cookies: [], origins: [], tabs: ["https://example.test/board?identity=1#open-tab"] }));
  await f.manager.start(profile!.id);
  expect(f.calls[1]!.urls).toEqual([]);
  expect(f.calls[1]!.options.restoreLastSession).toBe(true);
  expect(f.store.getSessionBundle(profile!.id)).toContain("?identity=1#open-tab");
});
test("monitored process-tree budget pauses sync and ignores obsolete generations", async () => {
  const f = fixture();
  const [profile] = await f.manager.bulkCreate({ count: 1, ramMb: 512, heapMb: 128 });
  f.manager.setPolicy(profile!.id, { budgetAction: "pause-sync" });
  await f.manager.start(profile!.id); f.manager.setManual(profile!.id, false);
  const launch = f.manager.getLaunch(profile!.id)!;
  const metrics: ResourceMetrics = { profileId: profile!.id, generation: launchGeneration(launch), pid: launch.pid, verified: true, memoryMb: 700,
    cpuPercent: 12, processCount: 4, sampledAt: Date.now() };
  f.emit([{ ...metrics, generation: "stale" }]);
  expect(f.manager.getProfile(profile!.id)?.memoryMb).toBeNull();
  f.emit([metrics]);
  expect(f.manager.getProfile(profile!.id)).toMatchObject({ state: "manual", manual: true, overBudget: true, memoryMb: 700, processCount: 4, resourcePolicy: "monitored" });
  expect(() => f.manager.setManual(profile!.id, false)).toThrow("exceeds");
  await f.manager.stop(profile!.id); f.emit([metrics]);
  expect(f.manager.getProfile(profile!.id)).toMatchObject({ state: "stopped", memoryMb: null, overBudget: false });
});
test("launches are coalesced per profile and limited to four concurrent native starts", async () => {
  const f = fixture();
  const profiles = await f.manager.bulkCreate({ count: 6 });
  let running = 0, maximum = 0;
  const gates: Array<() => void> = [];
  const original = f.launcher.start;
  f.launcher.start = async (...args) => {
    running++; maximum = Math.max(maximum, running);
    await new Promise<void>((done) => gates.push(done));
    running--; return original(...args);
  };
  const first = f.manager.start(profiles[0]!.id);
  expect(f.manager.start(profiles[0]!.id)).toBe(first);
  const tasks = [first, ...profiles.slice(1).map((profile) => f.manager.start(profile.id))];
  for (let iteration = 0; iteration < 10; iteration++) {
    await Bun.sleep(2);
    for (const release of gates.splice(0)) release();
  }
  await Promise.all(tasks);
  expect(maximum).toBe(4); expect(f.calls.length).toBe(6);
});
test("failed shutdown retains error/quarantine instead of claiming stopped", async () => {
  const f = fixture();
  const [profile] = await f.manager.bulkCreate({ count: 1 }); await f.manager.start(profile!.id);
  f.launcher.stop = async () => false;
  expect(await f.manager.stop(profile!.id)).toBe(false);
  expect(f.manager.getProfile(profile!.id)).toMatchObject({ state: "error", pid: 1002 });
  expect(f.manager.getLaunch(profile!.id)).not.toBeNull();
});
test("rapid start-stop-start-stop follows generations without orphaning a replacement", async () => {
  const f = fixture();
  const [profile] = await f.manager.bulkCreate({ count: 1 });
  const nativeStart = f.launcher.start;
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((done) => { entered = done; });
  let first = true;
  f.launcher.start = async (...args) => {
    if (first) { first = false; entered(); await new Promise<void>((done) => { release = done; }); }
    return nativeStart(...args);
  };
  const a = f.manager.start(profile!.id); await started;
  const b = f.manager.stop(profile!.id);
  const c = f.manager.start(profile!.id);
  const d = f.manager.stop(profile!.id);
  release(); await Promise.all([a, b, c, d]);
  expect(f.calls.length).toBe(2); expect(f.stopCalls.length).toBe(2);
  expect(f.manager.getLaunch(profile!.id)).toBeNull();
  expect(f.manager.getProfile(profile!.id)?.state).toBe("stopped");
});
test("a replacement start cannot clear an unconfirmed shutdown quarantine", async () => {
  const f = fixture();
  const [profile] = await f.manager.bulkCreate({ count: 1 }); await f.manager.start(profile!.id);
  f.launcher.stop = async () => false;
  const stop = f.manager.stop(profile!.id), replacement = f.manager.start(profile!.id);
  expect(await stop).toBe(false);
  await expect(replacement).rejects.toThrow("unconfirmed");
  expect(f.calls.length).toBe(1);
  expect(f.manager.getProfile(profile!.id)?.state).toBe("error");
});

test("closing start gates during warmup prevents late launches while ownership-aware stop remains usable", async () => {
  let ready!: (value: boolean) => void;
  const f = fixture(() => new Promise<boolean>(done => { ready = done; }));
  const [profile] = await f.manager.bulkCreate({ count: 1 });
  const opening = f.manager.start(profile!.id); const settled = opening.catch(() => null);
  await Bun.sleep(0); expect(f.manager.pendingStartIds()).toEqual([profile!.id]);
  f.manager.beginShutdown(); expect(() => f.manager.start(profile!.id)).toThrow("stopping");
  expect(f.manager.canEditProfile(profile!.id)).toBe(false); ready(true);
  expect(await settled).toBeNull(); expect(f.calls).toHaveLength(0);
  expect(await f.manager.stop(profile!.id)).toBe(true); expect(f.manager.pendingStartIds()).toEqual([]);
});
