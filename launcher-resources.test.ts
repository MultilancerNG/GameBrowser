import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Launcher, writeIdentityBookmark, type LauncherOptions } from "./launcher.ts";
import type { ProfileResourcePolicy } from "./profile-resources.ts";
import { ProfileStore } from "./store.ts";
import type { Profile } from "./types.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const run of cleanup.splice(0).reverse()) run(); });

function fixture(persistent = false) {
  const root = mkdtempSync(join(tmpdir(), "gamebrowser-resources-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new ProfileStore(persistent ? join(root, "profiles.sqlite") : ":memory:");
  cleanup.push(() => store.close());
  const profile: Profile = {
    id: "resources-one", accId: "", name: "Resources", group: "", username: "", password: "", twofa: "",
    proxy: null, ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/143.0.0.0 Safari/537.36",
    timezone: "", screenWidth: 1920, screenHeight: 1080, fingerprintSeed: 123,
    cookies: [{ name: "login", value: "preserve", domain: ".example.com", path: "/" }], seeded: true,
    hardware: { cores: 8 },
  };
  store.upsertProfile(profile);
  let alive = false;
  const spawned: string[][] = [];
  const options: LauncherOptions = {
    store, dataRoot: root, binaryPath: "/fake/chromium", unsafeDisableIdentityGates: true,
    hostPlatform: "linux", portProbe: () => true, captureFingerprint: async () => null,
    findProfileDirHolderPids: async () => [],
    spawn: (_binary, args) => { spawned.push(args); alive = true; return { pid: 6001, kill: () => { alive = false; } }; },
    fetch: async (url) => ({ ok: alive, json: async () => url.includes("/json/version")
      ? { webSocketDebuggerUrl: `ws://127.0.0.1:${new URL(url).port}/devtools/browser/test` }
      : [{ type: "page", url: "https://example.com/" }] }),
    ensureCookies: async () => ({ injected: false }), navigate: async () => {},
    isPidAlive: () => alive, findOwnedBrowserPids: async () => alive ? [6001] : [],
    browserClose: async () => false, killPid: async () => { alive = false; },
    cdpReadyTimeoutMs: 100, log: () => {},
  };
  return { root, store, profile: store.getProfile(profile.id)!, options, spawned };
}

test("Chromium leaves existing runtime arguments alone until optimization is enabled", () => {
  const f = fixture();
  const defaults = new Launcher(f.options).buildArgs(f.profile, 9333, f.root, ["--js-flags=--max-old-space-size=512"]);
  expect(defaults.filter((arg) => arg.startsWith("--js-flags="))).toEqual(["--js-flags=--max-old-space-size=512"]);
  expect(defaults).toContain(`--disk-cache-size=${20 * 1024 * 1024}`);
  const optimized = new Launcher({
    ...f.options,
    resourcePolicy: () => ({ ramBudgetMb: 1536, autoOptimize: true }),
    memorySnapshot: (activeProfiles) => ({ totalMb: 8192, freeMb: 4096, activeProfiles }),
  });
  const args = optimized.buildArgs(f.profile, 9333, f.root, ["--js-flags=--max-old-space-size=512", "--automation-launcher-pid=42"]);
  expect(args.filter((arg) => arg.startsWith("--js-flags="))).toEqual(["--js-flags=--max-old-space-size=768"]);
  expect(args).toContain("--automation-launcher-pid=42");
  expect(args.filter((arg) => arg.startsWith("--fingerprint-"))).toEqual(defaults.filter((arg) => arg.startsWith("--fingerprint-")));
  expect(() => optimized.buildArgs(f.profile, 9333, f.root, ["--js-flags=--expose-gc"])).toThrow("unsafe launch_args rejected");
});

test("explicit workspace heaps remain scoped and yield to the current opt-in resource policy", () => {
  const f = fixture();
  let optimized = false;
  const launcher = new Launcher({
    ...f.options,
    resourcePolicy: () => ({ ramBudgetMb: 512, autoOptimize: optimized }),
  });
  launcher.setWorkspaceHooks({
    profileResourceLimits: (profile) => profile.id === f.profile.id ? { v8OldSpaceMb: 1024, deviceScaleFactor: 1 } : undefined,
    profileExtensionDirs: (profile) => profile.id === f.profile.id ? [join(f.root, "managed-extension")] : undefined,
  });
  const flags = () => launcher.buildArgs(f.profile, 9333, f.root, ["--js-flags=--max-old-space-size=512"], undefined, true);
  expect(flags().filter((flag) => flag.startsWith("--js-flags="))).toEqual(["--js-flags=--max-old-space-size=1024"]);
  expect(flags()).toContain(`--load-extension=${join(f.root, "managed-extension")}`);
  expect(flags()).not.toContain("--disable-blink-features=AutomationControlled");
  optimized = true;
  expect(flags().filter((flag) => flag.startsWith("--js-flags="))).toEqual(["--js-flags=--max-old-space-size=256"]);
  const unrelated = { ...f.profile, id: "outside-workspace", fingerprintSeed: 124 };
  f.store.upsertProfile(unrelated);
  optimized = false;
  const native = launcher.buildArgs(unrelated, 9334, f.root, [], undefined, true);
  expect(native.some((flag) => flag.startsWith("--js-flags="))).toBe(false);
  expect(native.some((flag) => flag.startsWith("--load-extension="))).toBe(false);
});

test("workspace network routing survives manager reattach and saved mode edits without replacing the browser", async () => {
  const f = fixture();
  const savedProxy = { type: "http" as const, host: "proxy.example", port: "8080", user: "account", pass: "secret" };
  f.store.upsertProfile({ ...f.profile, proxy: savedProxy });
  let mode: "direct" | "system" = "direct";
  let exitLookups = 0;
  const options = { ...f.options, lookupExitLocation: async () => { exitLookups++; return null; } };
  const hooks = { profileNetworkMode: () => mode };
  const launcher = new Launcher(options);
  launcher.setWorkspaceHooks(hooks);
  const first = await launcher.start(f.profile.id, [], { headless: true });
  expect(f.spawned[0]).toContain("--no-proxy-server");
  expect(f.spawned[0]).toContain("--force-webrtc-ip-handling-policy=default_public_interface_only");
  expect(f.store.getLaunch(f.profile.id)?.networkMode).toBe("direct");
  mode = "system";
  const restarted = new Launcher(options);
  restarted.setWorkspaceHooks(hooks);
  expect(await restarted.start(f.profile.id, [], { headless: true })).toEqual({ ...first, nativeSessionRestored: false, reattached: true });
  expect(f.spawned).toHaveLength(1);
  expect(f.store.getLaunch(f.profile.id)?.networkMode).toBe("direct");
  expect(await restarted.certifiedActive(f.profile.id)).toBe(true);
  expect(await restarted.stop(f.profile.id)).toBe(true);
  await restarted.start(f.profile.id, [], { headless: true });
  expect(f.store.getLaunch(f.profile.id)?.networkMode).toBe("system");
  expect(f.spawned[1]).not.toContain("--no-proxy-server");
  expect(f.spawned[1]?.some((flag) => flag.startsWith("--proxy-server="))).toBe(false);
  expect(f.spawned[1]).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
  expect(f.store.getProfile(f.profile.id)?.proxy).toEqual(savedProxy);
  expect(exitLookups).toBe(0);
  await restarted.stop(f.profile.id);
});

test("managed extension context survives workspace recreation and a reopened store before hooks exist", async () => {
  const f = fixture(true);
  const original = join(f.root, "original-managed-extension");
  const replacement = join(f.root, "next-managed-extension");
  const paths = [original];
  const options = { ...f.options, headless: true };
  const first = new Launcher(options);
  first.setWorkspaceHooks({ profileExtensionDirs: () => paths });
  const opened = await first.start(f.profile.id);
  const originalLaunch = f.store.getLaunch(f.profile.id)!;
  expect(originalLaunch.managedExtensions).toEqual({ chromiumDirectories: [original], firefoxDirectories: [], firefoxAddonUUIDs: {} });
  paths[0] = replacement;
  const reopenedStore = new ProfileStore(join(f.root, "profiles.sqlite"));
  cleanup.push(() => reopenedStore.close());
  const restarted = new Launcher({ ...options, store: reopenedStore });
  expect(await restarted.start(f.profile.id)).toEqual({ ...opened, nativeSessionRestored: false, reattached: true });
  expect(await restarted.certifiedActive(f.profile.id)).toBe(true);
  restarted.setWorkspaceHooks({ profileExtensionDirs: () => paths });
  expect((await restarted.start(f.profile.id)).reattached).toBe(true);
  expect(f.spawned).toHaveLength(1);
  expect(reopenedStore.getLaunch(f.profile.id)!.personaDigest).toBe(originalLaunch.personaDigest);
  expect(await restarted.stop(f.profile.id)).toBe(true);
  await restarted.start(f.profile.id);
  expect(f.spawned).toHaveLength(2);
  expect(f.spawned[1]).toContain(`--load-extension=${replacement}`);
  expect(reopenedStore.getLaunch(f.profile.id)!.managedExtensions?.chromiumDirectories).toEqual([replacement]);
  await restarted.stop(f.profile.id);
});

test("invalid managed addon context is rejected before native spawn or durable ownership", async () => {
  const f = fixture();
  const launcher = new Launcher(f.options);
  launcher.setWorkspaceHooks({ profileExtensionDirs: () => ["invalid\0path"] });
  await expect(launcher.start(f.profile.id)).rejects.toThrow("browser_launch/preflight");
  expect(f.spawned).toHaveLength(0);
  expect(f.store.getLaunch(f.profile.id)).toBeNull();
});

test("workspace force stop retains generation checks and exact native ownership", async () => {
  const f = fixture();
  let graceful = 0;
  let killed = 0;
  const launcher = new Launcher({ ...f.options,
    browserClose: async () => { graceful++; return false; },
    killPid: async (pid) => { killed++; await f.options.killPid!(pid); },
  });
  await launcher.start(f.profile.id);
  const launch = f.store.getLaunch(f.profile.id)!;
  expect(await launcher.forceStop(f.profile.id, { ...launch, startedAt: launch.startedAt + 1 })).toBe(false);
  expect(killed).toBe(0);
  expect(await launcher.forceStop(f.profile.id, launch)).toBe(true);
  expect(graceful).toBe(0);
  expect(killed).toBe(1);
  expect(f.store.getLaunch(f.profile.id)).toBeNull();
});

test("concurrent bulk starts share automatic resources before launch reservations exist", async () => {
  const f = fixture();
  const profiles = [f.profile, ...[2, 3].map((number) => ({ ...f.profile, id: `resources-${number}`, fingerprintSeed: 123 + number }))];
  for (const profile of profiles.slice(1)) f.store.upsertProfile(profile);
  const samples: number[] = [];
  const launcher = new Launcher({
    ...f.options,
    resourcePolicy: () => ({ ramBudgetMb: null, autoOptimize: true }),
    memorySnapshot: (activeProfiles) => { samples.push(activeProfiles); return { totalMb: 4096, freeMb: 4096, activeProfiles }; },
  });
  await Promise.all(profiles.map((profile) => launcher.start(profile.id)));
  expect(samples).toEqual([2, 2, 2]);
  expect(f.spawned).toHaveLength(3);
  // Each gets a share for three browsers instead of three separate single-browser budgets.
  for (const args of f.spawned) expect(args).toContain("--js-flags=--max-old-space-size=384");
  for (const profile of profiles) await launcher.stop(profile.id);
});

test("resource allocation counts an in-flight reserved profile once and excludes its own launch", async () => {
  const f = fixture();
  const second = { ...f.profile, id: "resources-two", fingerprintSeed: 124 };
  f.store.upsertProfile(second);
  let releaseFirst!: () => void;
  let firstReserved!: () => void;
  const held = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const reserved = new Promise<void>((resolve) => { firstReserved = resolve; });
  const samples: number[] = [];
  const launcher = new Launcher({
    ...f.options,
    resourcePolicy: () => ({ ramBudgetMb: null, autoOptimize: true }),
    memorySnapshot: (activeProfiles) => { samples.push(activeProfiles); return { totalMb: 4096, freeMb: 4096, activeProfiles }; },
    ensureCookies: async (ws) => {
      if (new URL(ws).port === String(f.store.getLaunch(f.profile.id)?.debugPort)) {
        firstReserved();
        await held;
      }
      return { injected: false };
    },
  });
  const first = launcher.start(f.profile.id);
  try {
    await reserved;
    expect(f.store.getLaunch(f.profile.id)).not.toBeNull();
    await launcher.start(second.id);
    // The first is both pending and durably reserved, but represents one browser.
    expect(samples).toEqual([0, 1]);
  } finally {
    releaseFirst();
    await first;
  }
  launcher.buildArgs(second, 9444, f.root, []);
  expect(samples).toEqual([0, 1, 1]);
  for (const id of [f.profile.id, second.id]) await launcher.stop(id);
});

test("fresh launches sample resources once, preserve identity and native data, and apply edits after close", async () => {
  const f = fixture();
  let policy: ProfileResourcePolicy = { ramBudgetMb: null, autoOptimize: true, alwaysShowBookmarks: true };
  let policyReads = 0;
  const samples: number[] = [];
  const launcher = new Launcher({
    ...f.options,
    resourcePolicy: () => { policyReads++; return policy; },
    memorySnapshot: (activeProfiles) => { samples.push(activeProfiles); return { totalMb: 8192, freeMb: 4096, activeProfiles }; },
  });
  const dir = join(f.root, f.profile.id, "Default");
  const files = {
    "Network/Cookies": "native-cookie-bytes", "Local Storage/leveldb/data": "native-storage",
    "IndexedDB/site/data": "native-indexeddb", "Sessions/Tabs_1": "native-tab-bytes",
    "Extensions/kept/data": "extension-data", Bookmarks: JSON.stringify({ user: "bookmarks" }),
  };
  for (const [file, bytes] of Object.entries(files)) {
    const path = join(dir, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bytes);
  }
  const originalPrefs = { bookmark_bar: { show_on_all_tabs: false, custom: "keep" }, session: { restore_on_startup: 1 }, user: "keep" };
  writeFileSync(join(dir, "Preferences"), JSON.stringify(originalPrefs));
  const before = f.store.getProfile(f.profile.id);
  await launcher.start(f.profile.id, [], { restoreLastSession: false, resetStorage: false });
  const launch = f.store.getLaunch(f.profile.id)!;
  expect(policyReads).toBe(1);
  expect(samples).toEqual([0]);
  expect(f.spawned[0]).toContain("--js-flags=--max-old-space-size=768");
  expect(JSON.parse(readFileSync(join(dir, "Preferences"), "utf8"))).toEqual({ ...originalPrefs, bookmark_bar: { ...originalPrefs.bookmark_bar, show_on_all_tabs: true } });
  policy = { ramBudgetMb: 256, autoOptimize: true, alwaysShowBookmarks: false };
  const reattached = await launcher.start(f.profile.id);
  expect(reattached.reattached).toBe(true);
  expect(policyReads).toBe(1);
  expect(f.spawned).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(dir, "Preferences"), "utf8")).bookmark_bar.show_on_all_tabs).toBe(true);
  await launcher.stop(f.profile.id);
  await launcher.start(f.profile.id, [], { restoreLastSession: false, resetStorage: false });
  expect(policyReads).toBe(2);
  expect(samples).toEqual([0, 0]);
  expect(f.spawned[1]).toContain("--js-flags=--max-old-space-size=128");
  expect(JSON.parse(readFileSync(join(dir, "Preferences"), "utf8")).bookmark_bar.show_on_all_tabs).toBe(false);
  expect(f.store.getLaunch(f.profile.id)!.personaDigest).toBe(launch.personaDigest);
  expect(f.store.getLaunch(f.profile.id)!.persona).toEqual(launch.persona);
  expect(f.store.getProfile(f.profile.id)).toEqual(before);
  for (const [file, bytes] of Object.entries(files)) expect(readFileSync(join(dir, file), "utf8")).toBe(bytes);
  await launcher.stop(f.profile.id);
});

test("undefined bookmarks setting preserves existing Chromium preferences", async () => {
  const f = fixture();
  const dir = join(f.root, f.profile.id, "Default");
  mkdirSync(dir, { recursive: true });
  const prefs = { bookmark_bar: { show_on_all_tabs: false }, personal: "keep" };
  writeFileSync(join(dir, "Preferences"), JSON.stringify(prefs));
  const launcher = new Launcher(f.options);
  await launcher.start(f.profile.id);
  expect(JSON.parse(readFileSync(join(dir, "Preferences"), "utf8"))).toEqual(prefs);
  await launcher.stop(f.profile.id);
});

test("identity bookmark updates preserve nested user bookmarks and other roots", async () => {
  const f = fixture();
  const dir = join(f.root, f.profile.id, "Default");
  mkdirSync(dir, { recursive: true });
  const managed = { id: "5", date_added: "123", type: "url", name: "Old name", url: `http://127.0.0.1:50000/card?id=${f.profile.id}` };
  const folder = { id: "6", type: "folder", name: "Personal", children: [{ id: "7", type: "url", name: "Example", url: "https://example.com/" }] };
  const otherCard = { type: "url", name: "Other local tool", url: `http://127.0.0.1:8080/card?id=${f.profile.id}&user=true` };
  const bookmarks = { version: 1, custom: "keep", roots: {
    bookmark_bar: { id: "1", name: "Bookmarks bar", type: "folder", children: [folder, managed, otherCard] },
    other: { children: [{ name: "Elsewhere", type: "url", url: "https://elsewhere.example/" }] },
    synced: { children: [{ name: "Phone", type: "folder", children: [] }] },
  } };
  writeFileSync(join(dir, "Bookmarks"), JSON.stringify(bookmarks));
  await writeIdentityBookmark(join(f.root, f.profile.id), "New name", `http://127.0.0.1:50400/card?id=${f.profile.id}`);
  expect(JSON.parse(readFileSync(join(dir, "Bookmarks"), "utf8"))).toEqual({ ...bookmarks, roots: { ...bookmarks.roots,
    bookmark_bar: { ...bookmarks.roots.bookmark_bar, children: [folder, { ...managed, name: "New name", url: `http://127.0.0.1:50400/card?id=${f.profile.id}` }, otherCard] },
  } });
  expect(JSON.parse(readFileSync(join(dir, "Preferences"), "utf8")).bookmark_bar.show_on_all_tabs).toBe(true);
});

test("identity bookmark preparation leaves a malformed bookmark file intact", async () => {
  const f = fixture();
  const dir = join(f.root, f.profile.id, "Default");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Bookmarks"), "{partial-user-bookmarks");
  await writeIdentityBookmark(join(f.root, f.profile.id), "Name", `http://127.0.0.1:50400/card?id=${f.profile.id}`);
  expect(readFileSync(join(dir, "Bookmarks"), "utf8")).toBe("{partial-user-bookmarks");
  expect(existsSync(join(dir, "Preferences"))).toBe(false);
});
