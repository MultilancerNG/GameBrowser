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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gamebrowser-resources-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new ProfileStore(":memory:");
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
