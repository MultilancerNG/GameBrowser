import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNewProfile } from "../create.ts";
import { Launcher } from "../launcher.ts";
import { ProfileStore } from "../store.ts";
import { CloudBrowserCoordinator } from "../cloud-browser.ts";
import { PendingSyncQueue, type PendingSyncRuntime } from "../pending-sync.ts";
import { encodePortableProfile } from "../portable-profile.ts";
import { LifecycleAdmissionController } from "../lifecycle-admission.ts";
import { StakeModeWorkspace } from "../workspace/server.ts";
import { StandaloneCloudLifecycle } from "./cloud-lifecycle.ts";
import { StandaloneCloud, type StandaloneCloudContext } from "./cloud.ts";
import type { Profile } from "../types.ts";

const roots: string[] = [];
const owners: StandaloneCloudLifecycle[] = [];
const accounts: StandaloneCloud[] = [];
const spies: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) {
    // A simulated failed capture deliberately retains fake native ownership.
    // Fixture cleanup removes that record rather than probing a real process.
    const internals = owner as unknown as {
      queue?: PendingSyncRuntime;
      store?: ProfileStore;
      coordinator?: { stopHeartbeat(profileId: string): Promise<unknown> | null };
    };
    const queue = internals.queue?.queue();
    for (const open of queue?.listAllOpens() ?? []) {
      // A failed capture starts real storage watchers. Stop this fixture's
      // producers before removing its simulated native generation and folders.
      await internals.coordinator?.stopHeartbeat(open.profileId)?.catch(() => {});
      queue!.removeUnreadyCaptures(open.profileId, open.accountId, open.registrationId);
      queue!.removeOpenRegistration(open.profileId, open.accountId, open.registrationId);
      internals.store?.clearLaunch(open.profileId);
    }
    await owner.close();
  }
  for (const account of accounts.splice(0)) await account.close();
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
function profile(id: string, name: string, proxyHost?: string): Profile {
  return { ...buildNewProfile({ name, engine: "chromium", screen: "1280x720" }, () => false), id, name,
    ...(proxyHost ? { proxy: { type: "http" as const, host: proxyHost, port: "8080", user: "fixture-user", pass: "fixture-password" } } : {}) };
}
function setup(options: { desktop?: boolean; env?: NodeJS.ProcessEnv; relayUrl?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gamebrowser-cloud-owner-")); roots.push(root);
  spies.push(spyOn(Launcher.prototype, "reconcileOrphans").mockResolvedValue({ cleared: 0 }));
  spies.push(spyOn(Launcher.prototype, "certifySurvivors").mockResolvedValue({ certified: 0, stopped: 0 }));
  const owner = new StandaloneCloudLifecycle({ root, assets: {}, syncExtensionRoot: join(import.meta.dir, "..", "extensions", "stakemode-sync"),
    admission: new LifecycleAdmissionController(), ...options });
  owners.push(owner); return { root, owner };
}
function context(accountId: string, rosterInput: Array<{ id: string; permission?: "view" | "edit"; name?: string }> = [], queueKey?: string) {
  let current = true, authenticated = true, rows = rosterInput;
  const events: string[] = [];
  const currentStatus = () => ({ account: { id: accountId }, legal: {
    current: { terms: "1", privacy: "1", acceptableUse: "1" }, accepted: { terms: "1", privacy: "1", acceptableUse: "1" },
  } });
  const payloads = new Map(rosterInput.map(row => [row.id, profile(row.id, row.name ?? `${accountId}:${row.id}`)]));
  const client = {
    status: async () => { events.push("status"); return currentStatus(); },
    listProfiles: async () => ({ profiles: rows.map(row => ({ id: row.id, name: row.name ?? `${accountId}:${row.id}`, group: "", platform: "", tags: [], version: 1,
      trashedAt: null, updatedAt: 1, activeOpens: [], permission: row.permission ?? "edit" })) }),
    getProfile: async (id: string) => {
      events.push(`payload:${id}`);
      const value = payloads.get(id);
      if (!value) throw new Error("Profile unavailable");
      return { profile: { id, version: 1, permission: rows.find(row => row.id === id)?.permission ?? "edit", trashedAt: null }, payload: encodePortableProfile(value) };
    },
    heartbeat: async () => ({ ok: true, revoked: false, activeOpens: [] }),
    abandon: async () => ({ ok: true, status: "abandoned" }),
    closeOpen: async () => ({ ok: true, status: "accepted", version: 2 }),
  };
  const auth = { state: () => ({ authenticated }), hasSession: () => authenticated, signOut: async () => { events.push("auth-signout"); authenticated = false; } };
  const value = { auth, connection: { client, accountId: () => accountId, deviceId: () => `${accountId}-device` }, configuration: { baseUrl: "https://cloud.example.test", authUrl: "https://auth.example.test", anonKey: "public" },
    generation: accountId === "accountA" ? 1 : 2, current: () => current, ...(queueKey ? { queueKey } : {}) } as unknown as StandaloneCloudContext;
  return { value, client, auth, payloads, events, currentStatus, revoke: () => { current = false; }, setRoster: (next: typeof rows) => { rows = next; } };
}
const snapshot = (workspace: StakeModeWorkspace) => workspace.snapshot() as { profiles: Array<{ id: string; name: string; proxy: { host: string } | null }>; error?: string };
function retainFailedCapture(owner: StandaloneCloudLifecycle) {
  const app = owner.appContext()!, internals = owner as unknown as { queue: PendingSyncRuntime; launcher: Launcher };
  const queue = internals.queue.queue()!;
  app.store.upsertProfile(profile("retained", "Keep my unsaved session"));
  app.store.recordLaunch({ profileId: "retained", pid: 987654, debugPort: 9222, ws: "ws://127.0.0.1:9222/fixture", startedAt: 1000, sessionBaseVersion: 4 });
  queue.recordOpen({ accountId: "accountA", profileId: "retained", registrationId: "retained-open", expectedVersion: 4 });
  queue.updateOpen("retained", "accountA", "running", { debugPort: 9222, startedAt: 1000 });
  spies.push(spyOn(internals.launcher, "reconcileOrphan").mockResolvedValue("alive"));
  spies.push(spyOn(internals.launcher, "verifyRunningIdentity").mockResolvedValue());
  const stop = spyOn(internals.launcher, "stop").mockResolvedValue(false); spies.push(stop);
  const options = (app.coordinator as unknown as { options: { readSession: () => Promise<string> } }).options;
  options.readSession = async () => { throw new Error("fixture capture failure"); };
  return { app, queue, stop };
}

test("Cloud composes an actual isolated cache/coordinator/workspace and exposes only the current editable roster", async () => {
  const { owner, root } = setup();
  const local = new ProfileStore(join(root, "profiles.sqlite")); local.upsertProfile(profile("local-only", "Private local profile")); local.close();
  const account = context("accountA", [{ id: "edit", permission: "edit" }, { id: "view", permission: "view" }]);
  await owner.authenticate(account.value);
  const app = owner.appContext()!;
  expect(app.store).toBeInstanceOf(ProfileStore); expect(app.coordinator).toBeInstanceOf(CloudBrowserCoordinator); expect(app.workspace).toBeInstanceOf(StakeModeWorkspace);
  app.store.upsertProfile(profile("foreign-cache", "Other account cached identity"));
  expect(snapshot(app.workspace).profiles.map(row => row.id)).toEqual(["edit"]);
  expect(JSON.stringify(snapshot(app.workspace))).not.toMatch(/Private local profile|Other account cached identity|fixture-password/);
  expect(app.workspace.manager.getProfile("view")).toBeNull(); expect(app.workspace.manager.getProfile("local-only")).toBeNull();
  await expect(app.workspace.manager.bulkCreate({ count: 1 })).rejects.toThrow();
  await owner.signingOut(account.value);
  expect(owner.appContext()).toBeUndefined(); expect(account.auth.hasSession()).toBe(true);
});

test("Cloud browsers cannot prepare extensions until their own relay route is configured", async () => {
  const { owner, root } = setup();
  const account = context("accountA", [{ id: "unconfigured" }]);
  await owner.authenticate(account.value);
  const app = owner.appContext()!;
  await expect(app.workspace.manager.start("unconfigured")).rejects.toThrow();
  const scope = (app.workspace.snapshot() as { capabilities: { contextKey: string } }).capabilities.contextKey;
  expect(existsSync(join(root, "live-workspace", scope, "sync-extensions", "unconfigured", "config.json"))).toBe(false);
  expect(owner.listLaunches()).toEqual([]);
  expect(() => setup({ relayUrl: "ws://127.0.0.1:8080/relay" })).toThrow("own local Cloud relay route");
});

test.each([
  { nextAccount: "accountB", service: "https://cloud.example.test", scenario: "a different account" },
  { nextAccount: "accountA", service: "https://other-cloud.example.test", scenario: "a different service with the same account ID" },
])("fresh Cloud contexts cannot expose colliding cache fields from $scenario", async ({ nextAccount, service }) => {
  const { owner } = setup();
  const first = context("accountA", [{ id: "same-id", name: "Account A private name" }]);
  await owner.authenticate(first.value);
  owner.appContext()!.store.upsertProfile(profile("same-id", "Account A private name", "account-a-private-proxy.test"));
  await owner.signingOut(first.value);
  const second = context(nextAccount, [{ id: "same-id", name: "Account B profile" }]);
  second.value.configuration.baseUrl = service;
  await owner.authenticate(second.value);
  const app = owner.appContext()!, visible = snapshot(app.workspace);
  expect(visible.profiles).toHaveLength(1);
  expect(visible.profiles[0]!.name).toBe("Account B profile");
  expect(JSON.stringify(visible)).not.toMatch(/Account A private name|account-a-private-proxy/);
  expect(JSON.stringify(await owner.profiles.list())).not.toMatch(/account-a-private-proxy/);
  await expect(owner.resolve(first.value)).rejects.toThrow("Sign in");
});

test("roster revocation removes cached profiles immediately and stale account contexts cannot resolve the workspace", async () => {
  const { owner } = setup();
  const account = context("accountA", [{ id: "revoked", permission: "edit" }]);
  await owner.authenticate(account.value);
  const workspace = await owner.resolve(account.value);
  expect(snapshot(workspace).profiles.map(row => row.id)).toEqual(["revoked"]);
  account.setRoster([{ id: "revoked", permission: "view" }]);
  await owner.profiles.list();
  expect(snapshot(workspace).profiles).toEqual([]); expect(workspace.manager.getProfile("revoked")).toBeNull();
  account.revoke();
  expect(snapshot(workspace).profiles).toEqual([]); expect(owner.appContext()).toBeUndefined();
  await expect(owner.resolve(account.value)).rejects.toThrow();
  expect(account.auth.hasSession()).toBe(true);
});

test("a permission downgrade between roster and authoritative payload cannot hydrate an editable workspace", async () => {
  const { owner } = setup(), account = context("accountA", [{ id: "downgraded", permission: "edit" }]);
  const read = account.client.getProfile;
  account.client.getProfile = async id => {
    const result = await read(id);
    return { ...result, profile: { ...result.profile, permission: "view" as const } };
  };
  await expect(owner.authenticate(account.value)).rejects.toThrow();
  expect(owner.appContext()).toBeUndefined();
});

test("native queue keys are generated once for credential storage without a plaintext key file or environment override", async () => {
  const environmentKey = Buffer.alloc(32, 5).toString("base64");
  const { owner, root } = setup({ desktop: true, env: { ALIASMODE_QUEUE_ENCRYPTION_KEY: environmentKey } });
  await owner.authenticate(context("accountA").value);
  const key = owner.takeCreatedQueueKey();
  expect(typeof key).toBe("string"); expect(Buffer.from(key!, "base64")).toHaveLength(32); expect(key).not.toBe(environmentKey);
  expect(owner.takeCreatedQueueKey()).toBeUndefined(); expect(existsSync(join(root, "pending-sync.key"))).toBe(false);
});

test("a native encrypted queue without its saved key is refused without replacing its captured state", async () => {
  const { owner, root } = setup({ desktop: true });
  const key = Buffer.alloc(32, 7), path = join(root, "pending-sync.sqlite");
  const queue = new PendingSyncQueue(path, key); queue.recordOpen({ accountId: "accountA", profileId: "retained", registrationId: "private-registration", expectedVersion: 4 }); queue.close();
  writeFileSync(join(root, "config.json"), JSON.stringify({ version: 1, mode: "cloud", cloudUrl: "https://cloud.example.test", localAnalytics: false }));
  const before = readFileSync(path), account = context("accountA");
  await expect(owner.authenticate(account.value)).rejects.toThrow("stored encryption key");
  expect(owner.appContext()).toBeUndefined(); expect(owner.takeCreatedQueueKey()).toBeUndefined(); expect(readFileSync(path)).toEqual(before);
  const recovered = new PendingSyncQueue(path, key);
  try { expect(recovered.getOpen("retained", "accountA")?.registrationId).toBe("private-registration"); }
  finally { recovered.close(); }
});

test("a ready close captured for one service is never submitted to another service with the same account ID", async () => {
  const { owner, root } = setup(), first = context("accountA");
  first.client.closeOpen = async () => { throw new Error("First Cloud service is offline"); };
  await owner.authenticate(first.value);
  const queue = (owner as unknown as { queue: PendingSyncRuntime }).queue.queue()!;
  const saved = profile("same-id", "First service private profile");
  saved.cookies = [{ name: "session", value: "first-service-only-cookie", domain: ".example.test", path: "/" }];
  const pending = queue.enqueue({ accountId: "accountA", profileId: "same-id", registrationId: "first-service-registration", expectedVersion: 1, payload: encodePortableProfile(saved) });
  await owner.signingOut(first.value);
  const key = Buffer.from(readFileSync(join(root, "pending-sync.key"), "utf8").trim(), "base64");
  const second = context("accountA"); second.value.configuration.baseUrl = "https://another-cloud.example.test";
  let wrongServiceSubmissions = 0;
  second.client.closeOpen = async () => { wrongServiceSubmissions++; return { ok: true, status: "accepted", version: 2 }; };
  // Refusing the change or selecting a separate service-bound queue is safe.
  try { await owner.authenticate(second.value); } catch {}
  expect(wrongServiceSubmissions).toBe(0);
  const retained = new PendingSyncQueue(join(root, "pending-sync.sqlite"), key);
  try { expect(retained.get(pending, "accountA")?.registrationId).toBe("first-service-registration"); }
  finally { retained.close(); }
});

test("quiesce and close fence an authentication response already in flight before it creates a workspace", async () => {
  const { owner } = setup({ desktop: true });
  const account = context("accountA", [{ id: "late" }]), entered = deferred<void>(), response = deferred<ReturnType<typeof account.currentStatus>>();
  account.client.status = async () => { entered.resolve(); return response.promise; };
  const authenticating = owner.authenticate(account.value);
  await entered.promise;
  await owner.quiesce(); await owner.close(); response.resolve(account.currentStatus());
  await expect(authenticating).rejects.toThrow();
  expect(owner.appContext()).toBeUndefined(); expect(owner.takeCreatedQueueKey()).toBeUndefined(); expect(owner.listLaunches()).toEqual([]);
  await expect(owner.authenticate(account.value)).rejects.toThrow("stopping");
});

test("a real coordinator capture failure keeps the browser ownership and authentication available when sign-out is cancelled", async () => {
  const { owner } = setup();
  const account = context("accountA", [{ id: "retained" }]); await owner.authenticate(account.value);
  const { app, queue, stop } = retainFailedCapture(owner);
  await expect(owner.signingOut(account.value)).rejects.toThrow("sign-out was cancelled");
  expect(stop).not.toHaveBeenCalled(); expect(queue.getOpen("retained", "accountA")?.registrationId).toBe("retained-open");
  expect(app.store.getLaunch("retained")?.startedAt).toBe(1000); expect(owner.appContext()).toBeDefined();
  expect(account.auth.hasSession()).toBe(true); expect(account.value.current()).toBe(true); expect(account.events).not.toContain("auth-signout");
});

test("cancelled capture failure also keeps real CloudAuth credentials and device binding through the public sign-out flow", async () => {
  const { owner, root } = setup(), events: string[] = [];
  const status = { ok: true, account: { id: "accountA", email: "fixture@example.test", emailVerified: true },
    workspace: { id: "workspace", ownerAccountId: "accountA", name: "Team", role: "owner" },
    device: { id: "device", label: "GameBrowser", platform: "linux", appVersion: "test", createdAt: 1, lastSeenAt: 1, revokedAt: null, current: true },
    legal: { current: { terms: "1", privacy: "1", acceptableUse: "1" }, accepted: { terms: "1", privacy: "1", acceptableUse: "1" } } };
  const account = new StandaloneCloud({ root, onAuthenticated: value => owner.authenticate(value), onSigningOut: value => owner.signingOut(value), fetchFn: async url => {
    const path = new URL(url).pathname;
    if (path === "/auth/v1/token") return Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600, user: { id: "accountA", email: "fixture@example.test", email_confirmed_at: "verified" } });
    if (path === "/auth/v1/logout") { events.push("auth-logout"); return Response.json({}); }
    if (path === "/v1/account/bootstrap") return Response.json({ ...status, deviceCredential: "fixture-device" });
    if (path === "/v1/status") return Response.json(status);
    if (path === "/v1/profiles") return Response.json({ ok: true, profiles: [] });
    throw new Error("Unexpected Cloud fixture request");
  } });
  accounts.push(account);
  account.configure({ baseUrl: "https://cloud.example.test", authUrl: "https://auth.example.test" });
  await account.signIn("fixture@example.test", "fixture-password");
  const previous = account.context()!, { app, queue } = retainFailedCapture(owner);
  await expect(account.signOut()).rejects.toThrow("sign-out was cancelled");
  expect(account.state().authenticated).toBe(true); expect(previous.auth.hasSession()).toBe(true); expect(previous.current()).toBe(true);
  expect(previous.connection.accountId()).toBe("accountA"); expect(previous.connection.deviceId()).toBe("device"); expect(events).not.toContain("auth-logout");
  expect(app.store.getLaunch("retained")).not.toBeNull(); expect(queue.getOpen("retained", "accountA")).not.toBeNull();
});
