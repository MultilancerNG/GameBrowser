import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Launcher, matchProfileDirHolderPids } from "../launcher.ts";
import { buildNewProfile } from "../create.ts";
import { ProfileStore } from "../store.ts";
import { startFirefoxOwner } from "../firefox-runtime.ts";
import { firefoxLaunchOptions, firefoxManagedConfig, prepareManagedFirefoxPrefs } from "../firefox-worker.mjs";
import { ProcessManager } from "./processManager.ts";
import { effectiveProfileProxy, legacyNetworkMode, type NetworkMode } from "./networkPolicy.ts";
import { WorkspacePolicyStore } from "./profileStore.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture(holders: () => Promise<number[] | null> = async () => []) {
  const root = mkdtempSync(join(tmpdir(), "stakemode-network-"));
  const store = new ProfileStore(join(root, "profiles.sqlite"));
  let mode: NetworkMode | undefined;
  let killed = 0;
  const launcher = new Launcher({ store, dataRoot: join(root, "profiles"), binaryPath: "fake-chromium", unsafeDisableIdentityGates: true,
    findProfileDirHolderPids: holders, profileNetworkMode: () => mode, killPid: async () => { killed++; } });
  const manager = new ProcessManager({ launcher, store, stateRoot: root, warmProcessService: async () => true, monitorFactory: () => ({ start() {}, dispose() {} }) });
  cleanups.push(() => { manager.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, launcher, manager, killed: () => killed, mode(value: NetworkMode | undefined) { mode = value; } };
}
test("network modes preserve saved proxy authentication while actual Chromium route changes", async () => {
  const f = fixture();
  const [view] = await f.manager.bulkCreate({ count: 1, proxies: ["http://account:private-password@proxy.example:8080"] });
  const id = view!.id, original = f.store.getProfile(id)!;
  expect(view?.networkMode).toBe("proxy");
  for (const mode of ["direct", "system", "proxy"] as const) {
    const updated = f.manager.updateNetwork(id, { networkMode: mode }); f.mode(mode);
    const flags = f.launcher.buildArgs(f.store.getProfile(id)!, 9222, f.launcher.userDataDir(id), []);
    expect(flags.includes("--no-proxy-server")).toBe(mode === "direct");
    expect(flags.some(flag => flag.startsWith("--proxy-server="))).toBe(mode === "proxy");
    expect(flags).toContain(`--force-webrtc-ip-handling-policy=${mode === "direct" ? "default_public_interface_only" : "disable_non_proxied_udp"}`);
    expect(updated.networkMode).toBe(mode);
    expect(JSON.stringify(updated)).not.toContain("private-password");
    expect(f.store.getProfile(id)?.proxy).toEqual(original.proxy);
  }
  expect(f.manager.getProfile(id)?.networkSummary).toContain("authenticated");
  expect(new WorkspacePolicyStore(f.root).get(id).networkMode).toBe("proxy");
});
test("legacy migration and explicit proxy validation fail closed without clearing unused endpoints", async () => {
  const f = fixture();
  const profile = buildNewProfile({}, () => false); f.store.upsertProfile(profile);
  expect(f.manager.getProfile(profile.id)?.networkMode).toBe("direct");
  expect(legacyNetworkMode({ proxy: null, proxyError: "invalid" })).toBe("proxy");
  expect(() => f.manager.updateNetwork(profile.id, { networkMode: "proxy" })).toThrow("requires an explicit");
  expect(() => effectiveProfileProxy({ proxy: { type: "https", host: "proxy.example", port: "443", user: "secret-user", pass: "secret-pass" } }, "proxy")).toThrow("Authenticated HTTPS");
  f.manager.updateNetwork(profile.id, { networkMode: "system", proxy: "socks5://user:pass@proxy.example:1080" });
  f.manager.setPolicy(profile.id, { networkMode: "direct" } as any);
  expect(f.manager.getNetworkMode(profile.id)).toBe("system");
  f.store.recordLaunch({ profileId: profile.id, pid: 8001, debugPort: 9222, ws: "ws://localhost:9222", startedAt: Date.now() });
  expect(f.manager.canEditProfile(profile.id)).toBe(false);
  expect(() => f.manager.updateNetwork(profile.id, { networkMode: "direct" })).toThrow("stop the profile");
  f.store.clearLaunch(profile.id);
});
test("network mode, managed Firefox paths and runtime UUIDs participate in identity certification", () => {
  const f = fixture();
  const profile = buildNewProfile({ proxy: { type: "http", host: "proxy.example", port: "8080", user: "u", pass: "p" } }, () => false); f.store.upsertProfile(profile);
  f.mode("direct"); const direct = (f.launcher as any).launchPersonaDigest(profile, "a".repeat(64), true);
  f.mode("system"); const system = (f.launcher as any).launchPersonaDigest(profile, "a".repeat(64), true);
  f.mode("proxy"); const proxy = (f.launcher as any).launchPersonaDigest(profile, "a".repeat(64), true);
  expect(new Set([direct, system, proxy]).size).toBe(3);
  expect(proxy).toMatch(/^[a-f0-9]{64}$/);
  const firefox = { ...profile, engine: "firefox" as const, firefox: { config: {} } };
  let addons = [join(f.root, "addon-one")];
  let uuids = { "addon@example.test": "1a05d4a9-a4b7-4bc7-8522-5a6fbffabf3d" };
  const launcher = new Launcher({ store: f.store, profileFirefoxAddonDirs: () => addons, profileFirefoxAddonUUIDs: () => uuids });
  const digest = () => (launcher as any).launchPersonaDigest(firefox, "a".repeat(64), true);
  const original = digest(); addons = [join(f.root, "addon-two")];
  const changedPath = digest(); uuids = { "addon@example.test": "bded29e5-03f3-4fba-aa80-42a9df48e524" };
  expect(new Set([original, changedPath, digest()]).size).toBe(3);
});
test("Firefox launch modes use explicit native prefs and reject contradictory proxy input", () => {
  expect(firefoxLaunchOptions({ networkMode: "direct" }).firefoxUserPrefs).toMatchObject({ "network.proxy.type": 0 });
  expect(firefoxLaunchOptions({ networkMode: "system" }).firefoxUserPrefs).toMatchObject({ "network.proxy.type": 5 });
  expect(firefoxLaunchOptions({ networkMode: "proxy", proxy: { server: "http://127.0.0.1:3080" } }).firefoxUserPrefs).toMatchObject({ "network.proxy.type": 1 });
  expect(() => firefoxLaunchOptions({ networkMode: "system", proxy: { server: "http://proxy.example:8080" } })).toThrow();
  expect(() => firefoxLaunchOptions({ networkMode: "proxy" })).toThrow();
  const directory = join(tmpdir(), "trusted-addon");
  expect(firefoxManagedConfig({ config: { addons: ["untrusted-path"], locale: "en-US" }, addonDirs: [directory] })).toEqual({ addons: [directory], locale: "en-US" });
  expect(firefoxManagedConfig({ config: { addons: ["untrusted-path"] } }).addons).toEqual([]);
  expect(() => firefoxManagedConfig({ config: {}, addonDirs: ["../relative"] })).toThrow();
});
test("system mode blocks non-proxied WebRTC even without a saved proxy while direct retains its default-route policy", () => {
  const f = fixture(), profile = buildNewProfile({}, () => false); f.store.upsertProfile(profile);
  f.mode("system");
  expect(f.launcher.buildArgs(profile, 9222, f.launcher.userDataDir(profile.id), [])).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
  expect(firefoxLaunchOptions({ networkMode: "system" }).firefoxUserPrefs).toMatchObject({ "network.proxy.type": 5,
    "media.peerconnection.ice.proxy_only": true, "media.peerconnection.ice.default_address_only": true, "media.peerconnection.ice.no_host": true });
  f.mode("direct");
  expect(f.launcher.buildArgs(profile, 9222, f.launcher.userDataDir(profile.id), [])).toContain("--force-webrtc-ip-handling-policy=default_public_interface_only");
  expect(firefoxLaunchOptions({ networkMode: "direct" }).firefoxUserPrefs).toEqual({ "network.proxy.type": 0, "media.peerconnection.ice.default_address_only": true, "fission.webContentIsolationStrategy": 1, "juggler.networkDetail": false });
});
test("Firefox reload history workaround survives every network/addon branch and is seeded before startup", async () => {
  const f = fixture(), uuid = "1a05d4a9-a4b7-4bc7-8522-5a6fbffabf3d";
  for (const input of [{}, { networkMode: "direct" }, { networkMode: "system" }, { networkMode: "proxy", proxy: { server: "http://127.0.0.1:3080" } },
    { networkMode: "direct", addonUUIDs: { "managed@example.test": uuid } }]) {
    expect(firefoxLaunchOptions(input).firefoxUserPrefs).toMatchObject({ "fission.webContentIsolationStrategy": 1 });
  }
  writeFileSync(join(f.root, "user.js"), 'user_pref("fission.webContentIsolationStrategy", 0);\nuser_pref("browser.startup.page", 0);\n');
  await prepareManagedFirefoxPrefs({ userDataDir: f.root });
  await prepareManagedFirefoxPrefs({ userDataDir: f.root, networkMode: "system" });
  const contents = readFileSync(join(f.root, "user.js"), "utf8");
  expect(contents).toContain('user_pref("fission.webContentIsolationStrategy", 1);');
  expect(contents.match(/fission\.webContentIsolationStrategy/g)?.length).toBe(1);
  expect(contents).toContain('user_pref("browser.startup.page", 0);');
  expect(contents).not.toContain("fission.autostart");
});
test("Firefox network mode is written before launch while unrelated user preferences survive", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "user.js"), 'user_pref("browser.startup.page", 0);\nuser_pref("network.proxy.type", 1);\n');
  await prepareManagedFirefoxPrefs({ userDataDir: f.root, networkMode: "direct" });
  await prepareManagedFirefoxPrefs({ userDataDir: f.root, networkMode: "system" });
  const prefs = readFileSync(join(f.root, "user.js"), "utf8");
  expect(prefs).toContain('user_pref("browser.startup.page", 0);');
  expect(prefs).toContain('user_pref("network.proxy.type", 5);');
  expect(prefs.match(/network\.proxy\.type/g)?.length).toBe(1);
});
test("Firefox addon UUIDs are seeded before startup and preserve historical safe runtime origins", async () => {
  const f = fixture();
  const oldUUID = "1a05d4a9-a4b7-4bc7-8522-5a6fbffabf3d", managedUUID = "bded29e5-03f3-4fba-aa80-42a9df48e524";
  const preference = (mapping: Record<string, string>) => `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify(mapping))});`;
  writeFileSync(join(f.root, "prefs.js"), preference({ "historical@example.test": oldUUID, "managed@example.test": oldUUID }));
  writeFileSync(join(f.root, "user.js"), `user_pref("browser.startup.page", 0);\n${preference({ "user@example.test": oldUUID })}\n`);
  const first = await prepareManagedFirefoxPrefs({ userDataDir: f.root, addonUUIDs: { "managed@example.test": managedUUID } });
  expect(first).toEqual({ "historical@example.test": oldUUID, "user@example.test": oldUUID, "managed@example.test": managedUUID });
  const second = await prepareManagedFirefoxPrefs({ userDataDir: f.root, addonUUIDs: {}, networkMode: "system" });
  expect(second).toEqual(first);
  const contents = readFileSync(join(f.root, "user.js"), "utf8");
  expect(contents).toContain('user_pref("browser.startup.page", 0);');
  expect(contents.match(/extensions\.webextensions\.uuids/g)?.length).toBe(1);
  const launchPrefs = firefoxLaunchOptions({ addonUUIDs: second }).firefoxUserPrefs as Record<string, string | number | boolean>;
  expect(JSON.parse(launchPrefs["extensions.webextensions.uuids"] as string)).toEqual(first);
});
test("Firefox addon UUID seeding rejects hostile metadata and never evaluates profile JavaScript", async () => {
  const f = fixture(), uuid = "1a05d4a9-a4b7-4bc7-8522-5a6fbffabf3d";
  writeFileSync(join(f.root, "prefs.js"), 'user_pref("extensions.webextensions.uuids", (() => { globalThis.STAKEMODE_UUID_EVAL = true; return "{}"; })());\n');
  const mapping = await prepareManagedFirefoxPrefs({ userDataDir: f.root, addonUUIDs: { "trusted@example.test": uuid } });
  expect(mapping).toEqual({ "trusted@example.test": uuid });
  expect((globalThis as any).STAKEMODE_UUID_EVAL).toBeUndefined();
  for (const addonUUIDs of [JSON.parse(`{"__proto__":"${uuid}"}`), { "addon@example.test": "not-a-uuid" }, Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`addon-${index}@example.test`, uuid]))]) {
    expect(() => firefoxLaunchOptions({ addonUUIDs })).toThrow();
    await expect(startFirefoxOwner({ profileId: "invalid-addon", executablePath: "not-a-binary", executableSha256: "a".repeat(64), userDataDir: f.root, config: {}, addonUUIDs })).rejects.toThrow("input is invalid");
  }
  rmSync(join(f.root, "prefs.js"));
  const outside = join(f.root, "external-prefs.js"); writeFileSync(outside, "keep");
  symlinkSync(outside, join(f.root, "prefs.js"));
  await expect(prepareManagedFirefoxPrefs({ userDataDir: f.root, addonUUIDs: {} })).rejects.toThrow();
  expect(readFileSync(outside, "utf8")).toBe("keep");
});
test("idle deletion removes only its exact profile files, credentials, policy and metadata", async () => {
  const f = fixture();
  const [first, second] = await f.manager.bulkCreate({ count: 2 });
  for (const profile of [first!, second!]) { const directory = f.launcher.userDataDir(profile.id); mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, "Cookies"), profile.id); }
  const source = f.store.getProfile(first!.id)!;
  f.store.upsertProfile({ ...source, password: "stored-account-password", cookies: [{ name: "session", value: "secret-cookie", domain: "example.test", path: "/" }] });
  expect(await f.manager.deleteProfile(first!.id)).toEqual({ deleted: true, profileId: first!.id });
  expect(f.manager.getProfile(first!.id)).toBeNull(); expect(f.store.getSessionBundle(first!.id)).toBeNull();
  expect(existsSync(f.launcher.userDataDir(first!.id))).toBe(false);
  expect(readFileSync(join(f.launcher.userDataDir(second!.id), "Cookies"), "utf8")).toBe(second!.id);
  expect(readFileSync(join(f.root, "workspace", "policies.json"), "utf8")).not.toContain(first!.id);
  expect(f.killed()).toBe(0);
});
test("deletion refuses active, foreign-held, inconclusive, and symbolic-link directories", async () => {
  let holders: number[] | null = [777];
  const f = fixture(async () => holders);
  const [profile] = await f.manager.bulkCreate({ count: 1 });
  const directory = f.launcher.userDataDir(profile!.id); mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, "cookie"), "keep");
  await expect(f.manager.deleteProfile(profile!.id)).rejects.toThrow("ownership");
  holders = null; await expect(f.manager.deleteProfile(profile!.id)).rejects.toThrow("ownership");
  expect(readFileSync(join(directory, "cookie"), "utf8")).toBe("keep");
  holders = []; f.store.recordLaunch({ profileId: profile!.id, pid: 8001, debugPort: 9222, ws: "ws://localhost:9222", startedAt: Date.now() });
  await expect(f.manager.deleteProfile(profile!.id)).rejects.toThrow("stop the profile"); f.store.clearLaunch(profile!.id);
  rmSync(directory, { recursive: true }); const outside = join(f.root, "outside"); mkdirSync(outside); writeFileSync(join(outside, "keep"), "outside");
  symlinkSync(outside, directory, process.platform === "win32" ? "junction" : "dir");
  await expect(f.manager.deleteProfile(profile!.id)).rejects.toThrow("symbolic link");
  expect(readFileSync(join(outside, "keep"), "utf8")).toBe("outside"); expect(f.killed()).toBe(0);
});
test("deletion tombstone prevents new starts and edits while native ownership proof is pending", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const f = fixture(async () => { await gate; return []; });
  const [profile] = await f.manager.bulkCreate({ count: 1 });
  const removal = f.manager.deleteProfile(profile!.id);
  expect(f.manager.canEditProfile(profile!.id)).toBe(false);
  expect(() => f.manager.start(profile!.id)).toThrow("deletion");
  await expect(f.launcher.start(profile!.id)).rejects.toThrow("mutation");
  expect(() => f.manager.updateNetwork(profile!.id, { networkMode: "system" })).toThrow("stop the profile");
  release(); await removal;
});
test("copy creates a fresh identity without account data, proxy authentication, or assigned extensions", async () => {
  const f = fixture();
  const [original] = await f.manager.bulkCreate({ count: 1, engine: "firefox", proxies: ["http://operator:private@proxy.example:8080"], ramMb: 4096, heapMb: 1024 });
  const saved = f.store.getProfile(original!.id)!;
  f.store.upsertProfile({ ...saved, password: "account-secret", twofa: "totp-secret", extensions: ["extension-id"], cookies: [{ name: "session", value: "cookie-secret", domain: "example.test", path: "/" }],
    firefox: { ...saved.firefox!, config: { ...saved.firefox!.config, fonts: ["Source-only-font-marker"] } } });
  const published: Array<{ name: string; width: number; ramMb: number }> = [];
  f.manager.onChange(rows => { for (const row of rows) if (row.id !== original!.id) published.push({ name: row.name, width: row.screenWidth, ramMb: row.ramMb }); });
  const copy = await f.manager.copyProfile(original!.id, "Fresh account profile"), storedCopy = f.store.getProfile(copy.id)!;
  expect(copy.id).not.toBe(original!.id); expect(copy.name).toBe("Fresh account profile"); expect(copy.networkMode).toBe("proxy"); expect(copy.manual).toBe(true);
  expect(copy.screenWidth).toBe(original!.screenWidth); expect(copy.ramMb).toBe(4096);
  expect(storedCopy.fingerprintSeed).not.toBe(saved.fingerprintSeed); expect(storedCopy.cookies).toEqual([]); expect(storedCopy.password).toBe(""); expect(storedCopy.twofa).toBe("");
  expect(storedCopy.proxy).toMatchObject({ host: "proxy.example", user: "", pass: "" }); expect(storedCopy.extensions ?? []).toEqual([]);
  expect(storedCopy.firefox?.config.fonts).not.toEqual(["Source-only-font-marker"]);
  expect(published).toEqual([{ name: "Fresh account profile", width: original!.screenWidth, ramMb: 4096 }]);
  expect(f.manager.renameProfile(copy.id, "Renamed profile").name).toBe("Renamed profile");
});

test("untracked Firefox profile occupancy blocks local deletion without signalling any process", async () => {
  let directory = "";
  const f = fixture(async () => matchProfileDirHolderPids(directory, { incomplete: false,
    records: [{ pid: 9921, executablePath: "untracked-firefox", argv: ["firefox", "-profile", directory] }] }));
  const [profile] = await f.manager.bulkCreate({ count: 1, engine: "firefox" });
  directory = f.launcher.userDataDir(profile!.id); mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, "cookie"), "keep");
  await expect(f.manager.deleteProfile(profile!.id)).rejects.toThrow("ownership");
  expect(f.store.getProfile(profile!.id)).not.toBeNull(); expect(readFileSync(join(directory, "cookie"), "utf8")).toBe("keep");
  expect(f.killed()).toBe(0);
});
