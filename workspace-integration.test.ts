import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashboardWorkspace } from "./workspace-integration.ts";
import { StakeModeWorkspace } from "./workspace/server.ts";
import { ProfileStore } from "./store.ts";
import { buildNewProfile } from "./create.ts";
import { AppConfigStore } from "./app-config.ts";
import { statePaths } from "./paths.ts";

function fixture(mode: "local" | "cloud" | "unconfigured" = "local", sync?: any) {
  const root = mkdtempSync(join(tmpdir(), "gamebrowser-mounted-workspace-"));
  const store = new ProfileStore(join(root, "profiles.sqlite"));
  const appConfig = new AppConfigStore(join(root, "config.json"));
  if (mode !== "unconfigured") appConfig.setMode(mode, mode === "cloud" ? "https://cloud.example" : undefined);
  let account = "account-a", authenticated = true, failRoster = false, opens = 0, closes = 0, captures = 0;
  let roster = [{ id: "cloud-one", name: "Unopened shared browser", engine: "chromium", group: "Team", screen: "1366x768", permission: "edit", running: false, lockedBy: null }];
  let workspace: StakeModeWorkspace | undefined;
  const launcher = {
    setWorkspaceHooks() {},
    async start(id: string, _urls?: unknown, options?: any) {
      store.recordLaunch({ profileId: id, engine: "chromium", pid: 10001, debugPort: 9222, ws: "ws://127.0.0.1:9222/private", startedAt: 1, headless: options?.headless === true });
      return { ws: "ws://127.0.0.1:9222/private", port: 9222 };
    },
    async stop(id: string) { store.clearLaunch(id); return true; },
    async forceStop(id: string) { store.clearLaunch(id); return true; },
    async captureLocalSession() { captures++; return true; },
    async certifiedActive() { return true; },
  };
  const cloudBrowser = mode === "cloud" ? {
    async listRoster() { if (failRoster) throw new Error("network"); return { profiles: roster, healthSources: [] }; },
    async open(id: string, _args: unknown, options: any) {
      opens++;
      const profile = buildNewProfile({ name: "Decrypted immutable Cloud identity" }, () => false);
      store.upsertProfiles([{ ...profile, id }]);
      await launcher.start(id, [], options); return { ok: true };
    },
    async close(id: string) { closes++; store.clearLaunch(id); return { closed: true, sync: "complete" }; },
  } : undefined;
  const runtime = new DashboardWorkspace({ launcher, store, appConfig, paths: statePaths(root),
    cloudBrowser, cloudAuth: { state: () => ({ authenticated }) }, cloudConnection: { accountId: () => account },
  } as any, { sync, createWorkspace: options => workspace = new StakeModeWorkspace({ ...options,
    managerOptions: { ...options.managerOptions, monitorFactory: () => ({ start() {}, dispose() {} }), warmProcessService: async () => true },
    bridgeFactory: () => ({ start() {}, stop: async () => {}, attach: async () => {}, detach: async () => {}, setVisible() {} }) as any,
  }) });
  const request = (path: string, token?: string, body?: unknown, method?: string) => new Request(`http://127.0.0.1:45678/workspace/api/${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { host: "127.0.0.1:45678", "x-stakemode-workspace": "1", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { runtime, request, store, launcher, appConfig, get workspace() { return workspace!; },
    get opens() { return opens; }, get closes() { return closes; }, get captures() { return captures; },
    setAccount(value: string) { account = value; }, setAuthenticated(value: boolean) { authenticated = value; },
    setFailRoster(value: boolean) { failRoster = value; }, setRoster(value: typeof roster) { roster = value; },
    async cleanup() { await runtime.stop(); store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("mounted workspace uses the existing dynamic origin and protects the first-run mode choice", async () => {
  const f = fixture("unconfigured");
  try {
    expect((await f.runtime.handle(f.request("bootstrap"), "127.0.0.1")).status).toBe(401);
    f.appConfig.setMode("cloud", "https://cloud.example");
    expect((await f.runtime.handle(f.request("bootstrap"), "127.0.0.1")).status).toBe(401);
    f.appConfig.setMode("local");
    const result = await (await f.runtime.handle(f.request("bootstrap"), "127.0.0.1")).json();
    expect(result.relayUrl).toBe("ws://127.0.0.1:45678/workspace/relay");
    expect(result.snapshot.capabilities.manageProfilesUrl).toBe("/?view=profiles");
    expect((await f.runtime.handle(f.request("bootstrap"), "192.168.0.1")).status).toBe(403);
  } finally { await f.cleanup(); }
});

test("Cloud roster displays uncached profiles, routes open/close through coordinator, and forbids local identity writes", async () => {
  const f = fixture("cloud");
  const privateProfile = buildNewProfile({ name: "Cached profile from another account" }, () => false);
  f.store.upsertProfiles([privateProfile]);
  try {
    const boot = await (await f.runtime.handle(f.request("bootstrap"), "127.0.0.1")).json();
    expect(boot.snapshot.profiles.map((p: any) => p.id)).toEqual(["cloud-one"]);
    expect(f.store.getProfile("cloud-one")).toBeNull();
    expect(boot.snapshot.capabilities.identityManagement).toBe(false);
    const bulk = await f.runtime.handle(f.request("bulk", boot.token, { count: 1 }), "127.0.0.1");
    expect(bulk.status).toBe(400); expect(f.store.listProfiles()).toHaveLength(1);
    expect((await f.runtime.handle(f.request("start", boot.token, { profileId: "cloud-one" }), "127.0.0.1")).status).toBe(200);
    expect(f.opens).toBe(1); expect(f.store.getLaunch("cloud-one")?.headless).toBe(true);
    expect((await f.runtime.handle(f.request("stop", boot.token, { profileId: "cloud-one" }), "127.0.0.1")).status).toBe(200);
    expect(f.closes).toBe(1);
  } finally { await f.cleanup(); }
});

test("account and edit-access changes fence old tokens, snapshots and controls without exposing cached profiles", async () => {
  const f = fixture("cloud");
  try {
    const boot = await (await f.runtime.handle(f.request("bootstrap"), "127.0.0.1")).json();
    const oldWorkspace = f.workspace;
    f.setAccount("account-b"); f.setRoster([{ id: "cloud-two", name: "Second account", engine: "chromium", group: "Team", screen: "1366x768", permission: "edit", running: false, lockedBy: null }]);
    const next = await (await f.runtime.handle(f.request("bootstrap"), "127.0.0.1")).json();
    expect(next.snapshot.profiles.map((p: any) => p.id)).toEqual(["cloud-two"]);
    expect((oldWorkspace.snapshot() as any).profiles).toEqual([]);
    expect((await f.runtime.handle(f.request("snapshot", boot.token), "127.0.0.1")).status).toBe(401);
    f.setRoster([]);
    const result = await (await f.runtime.handle(f.request("snapshot", next.token), "127.0.0.1")).json();
    expect(result.snapshot.profiles).toEqual([]);
    f.setFailRoster(true);
    expect((await f.runtime.handle(f.request("start", next.token, { profileId: "cloud-two" }), "127.0.0.1")).status).toBe(401);
    expect(f.opens).toBe(0);
  } finally { await f.cleanup(); }
});

test("Local workspace capture precedes stop and mounted teardown leaves browser lifecycle to the desktop", async () => {
  const f = fixture();
  const profile = buildNewProfile({ name: "Local browser", screen: "1366x768" }, () => false);
  f.store.upsertProfiles([profile]);
  try {
    const boot = await (await f.runtime.handle(f.request("bootstrap"), "127.0.0.1")).json();
    expect((await f.runtime.handle(f.request("start", boot.token, { profileId: profile.id }), "127.0.0.1")).status).toBe(200);
    expect((await f.runtime.handle(f.request("stop", boot.token, { profileId: profile.id }), "127.0.0.1")).status).toBe(200);
    expect(f.captures).toBe(1);
    await f.launcher.start(profile.id, [], { headless: true });
    await f.runtime.stop();
    expect(f.store.getLaunch(profile.id)).not.toBeNull();
  } finally { await f.cleanup(); }
});

function fakeSync() {
  const calls = { start: 0, save: 0, resume: 0, configure: 0, stop: 0, suspend: 0 };
  let state: any = { active: true, starting: false, waiting: false, saved: true, adminId: "cloud-one", followerIds: ["follower"], savedAdminId: "cloud-one", savedFollowerIds: ["follower"], failedFollowerIds: [], error: null };
  return { calls, status: () => structuredClone(state), currentPolicy: () => undefined,
    async start() { calls.start++; return state; }, async save() { calls.save++; return state; },
    async resume() { calls.resume++; return state; }, async configurePolicy() { calls.configure++; return state; },
    async stop() { calls.stop++; state = { ...state, active: false, adminId: null, followerIds: [] }; return state; },
    async suspend(message: string) { calls.suspend++; state = { ...state, active: false, error: message }; return state; },
  };
}

test("a transient Cloud roster failure suspends actions while retaining the configured roles", async () => {
  const sync = fakeSync(), f = fixture("cloud", sync);
  try {
    f.setRoster(["cloud-one", "follower"].map(id => ({ id, name: id, engine: "chromium", group: "Team", screen: "1366x768", permission: "edit", running: false, lockedBy: null })));
    await f.runtime.handle(f.request("bootstrap"), "127.0.0.1");
    expect(sync.calls.configure).toBe(0); // Opening the workspace never changes an existing group.
    f.setFailRoster(true);
    await (f.runtime as any).pollAccess();
    expect(sync.calls.suspend).toBe(1); expect(sync.calls.stop).toBe(0);
    expect(sync.status()).toMatchObject({ active: false, adminId: "cloud-one", followerIds: ["follower"] });
    f.setFailRoster(false);
    const boot = await (await f.runtime.handle(f.request("bootstrap"), "127.0.0.1")).json();
    expect(boot.snapshot.syncSession.adminId).toBe("cloud-one");
    expect(sync.calls.start).toBe(0); // Uncertain actions require explicit Resume.
  } finally { await f.cleanup(); }
});

test("an old account request whose body finishes after switching accounts cannot change the shared controller", async () => {
  for (const [path, body] of [
    ["sync", { adminId: "cloud-one", followerIds: ["follower"] }],
    ["sync", { action: "save", saveSession: false }],
    ["sync", { action: "resume" }],
    ["settings", { origins: ["https://example.test"], pacing: "paced" }],
  ] as const) {
    const sync = fakeSync(), f = fixture("cloud", sync);
    try {
      const boot = await (await f.runtime.handle(f.request("bootstrap"), "127.0.0.1")).json();
      let release!: ReadableStreamDefaultController<Uint8Array>, read!: () => void;
      const reading = new Promise<void>(resolve => { read = resolve; });
      const stream = new ReadableStream<Uint8Array>({ start(controller) { release = controller; }, pull() { read(); } }, { highWaterMark: 0 });
      const request = new Request(`http://127.0.0.1:45678/workspace/api/${path}`, {
        method: "POST", headers: { host: "127.0.0.1:45678", "x-stakemode-workspace": "1", authorization: `Bearer ${boot.token}`, "content-type": "application/json" }, body: stream,
      });
      const response = f.runtime.handle(request, "127.0.0.1");
      await reading;
      f.setAccount("account-b");
      await f.runtime.handle(f.request("bootstrap"), "127.0.0.1");
      release.enqueue(new TextEncoder().encode(JSON.stringify(body))); release.close();
      expect([400, 401, 403]).toContain((await response).status);
      expect(sync.calls.start).toBe(0); expect(sync.calls.save).toBe(0);
      expect(sync.calls.resume).toBe(0); expect(sync.calls.configure).toBe(0);
    } finally { await f.cleanup(); }
  }
});
