import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StandaloneCloud, type StandaloneCloudOptions } from "./cloud.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup(options: Partial<StandaloneCloudOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "gamebrowser-cloud-")); roots.push(root);
  let role = "owner", accountId = "owner", profileAvailable = true;
  const calls: Array<{ path: string; method: string; authorization: string | null; body: unknown }> = [];
  const status = () => ({ ok: true, account: { id: accountId, email: `${accountId}@example.com`, emailVerified: true },
    workspace: { id: "workspace", ownerAccountId: "owner", name: "Team", role },
    device: { id: "device", label: "GameBrowser", platform: "linux", appVersion: "test", createdAt: 1, lastSeenAt: 1, revokedAt: null, current: true },
    legal: { current: { terms: "1", privacy: "1", acceptableUse: "1" }, accepted: null } });
  const cloud = new StandaloneCloud({ root, fetchFn: async (url, init) => {
    const parsed = new URL(url), path = parsed.pathname;
    calls.push({ path, method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === "/auth/v1/token") return Response.json({ access_token: `access-${accountId}`, refresh_token: "fixture-refresh-secret", expires_in: 3600,
      user: { id: accountId, email: `${accountId}@example.com`, email_confirmed_at: "verified" } });
    if (path === "/auth/v1/logout") return Response.json({});
    if (path === "/v1/account/bootstrap") return Response.json({ ...status(), deviceCredential: "fixture-device-secret" });
    if (path === "/v1/status") return Response.json(status());
    if (path === "/v1/workspace/members") return Response.json({ ok: true, members: [{ accountId: "owner", email: "owner@example.com", role: "owner", joinedAt: 1, grants: [] }, { accountId: "member", email: "member@example.com", role: "member", joinedAt: 1, grants: [] }] });
    if (path === "/v1/workspace/invitations") return Response.json(init?.method === "POST" ? { ok: true, invitation: { id: "invite", ...JSON.parse(String(init.body)) } } : { ok: true, invitations: [] });
    if (path === "/v1/workspace/folders") return Response.json({ ok: true, folders: [{ name: "Shared / Group", archivedAt: null, permission: "edit", extensionDefaults: [] }] });
    if (path === "/v1/profiles") return Response.json({ ok: true, profiles: profileAvailable ? [{ id: "p1", name: "Cloud only", trashedAt: null, permission: "edit" }] : [] });
    if (path.includes("/grants/")) return Response.json({ ok: true, grant: JSON.parse(String(init?.body)) });
    throw new Error(`Unexpected Cloud mock path ${path}`);
  }, ...options });
  cloud.configure({ baseUrl: "https://cloud.example.test", authUrl: "https://auth.example.test" });
  return { cloud, root, calls, setRole: (value: string) => { role = value; }, setAccount: (value: string) => { accountId = value; }, removeProfile: () => { profileAvailable = false; } };
}

test("Cloud is optional and settings never persist passwords, access tokens or device credentials", async () => {
  const { cloud, root } = setup();
  expect(cloud.state()).toMatchObject({ configured: true, authenticated: false });
  await cloud.signIn("owner@example.com", "fixture-password-secret");
  expect(cloud.state()).toMatchObject({ authenticated: true, user: { id: "owner" } });
  const saved = readFileSync(join(root, "gamebrowser-settings.json"), "utf8");
  for (const secret of ["fixture-password-secret", "fixture-refresh-secret", "fixture-device-secret", "access-owner"]) expect(saved).not.toContain(secret);
  await cloud.signOut();
  expect(cloud.state().authenticated).toBe(false);
});

test("Team invitation and group/profile grants use live backend members and correctly encoded scopes", async () => {
  const { cloud, calls } = setup();
  await cloud.signIn("owner@example.com", "password");
  const team = await cloud.team();
  expect(team.profiles).toMatchObject([{ id: "p1", name: "Cloud only", trashedAt: null, permission: "edit" }]);
  await cloud.invite("new@example.com", "member");
  await cloud.share("group", "Shared / Group", "member", "view");
  await cloud.share("profile", "p1", "member", "edit");
  expect(calls).toContainEqual(expect.objectContaining({ path: "/v1/workspace/invitations", method: "POST", body: { email: "new@example.com", role: "member" } }));
  expect(calls).toContainEqual(expect.objectContaining({ path: "/v1/workspace/folders/Shared%20%2F%20Group/grants/member", method: "PUT", body: { permission: "view" } }));
  expect(calls).toContainEqual(expect.objectContaining({ path: "/v1/profiles/p1/grants/member", method: "PUT", body: { permission: "edit" } }));
  expect(calls.filter(call => call.path === "/v1/status")).toHaveLength(4);
  expect(calls.filter(call => call.path === "/v1/profiles")).toHaveLength(2);
});

test("Team actions reject revoked roles, removed profiles and stale account identity without cached authorization", async () => {
  const { cloud, calls, setRole, setAccount, removeProfile } = setup();
  await cloud.signIn("owner@example.com", "password");
  await cloud.team();
  setRole("member");
  await expect(cloud.invite("new@example.com", "member")).rejects.toThrow("administrator");
  expect(calls.some(call => call.path === "/v1/workspace/invitations" && call.method === "POST")).toBe(false);
  setRole("owner"); removeProfile();
  await expect(cloud.share("profile", "p1", "member", "edit")).rejects.toThrow("unavailable");
  setAccount("another-account");
  await expect(cloud.team()).rejects.toThrow("account changed");
});

test("Cloud lifecycle receives queue key and settles owned sessions before account invalidation", async () => {
  const events: string[] = [];
  const { cloud } = setup({ onCloudAuthenticated: async context => {
    events.push("authenticated"); expect(context.queueKey).toBe("private-queue-key"); expect(context.current()).toBe(true);
  }, onCloudSigningOut: async context => {
    events.push("settle"); expect(context.current()).toBe(true); expect(context.auth.hasSession()).toBe(true);
  } });
  await cloud.signIn("owner@example.com", "password", "private-queue-key");
  const context = cloud.context()!;
  await cloud.close();
  expect(events).toEqual(["authenticated", "settle"]);
  expect(context.current()).toBe(false);
});

test("Cloud service changes cannot replace an active account and unsafe service addresses are rejected", async () => {
  const { cloud } = setup();
  expect(() => cloud.configure({ baseUrl: "http://cloud.example.test" })).toThrow("HTTPS");
  expect(() => cloud.configure({ baseUrl: "https://user:secret@cloud.example.test" })).toThrow("credentials");
  await cloud.signIn("owner@example.com", "password");
  expect(() => cloud.configure({ baseUrl: "https://other.example.test" })).toThrow("Sign out");
  await expect(cloud.signIn("member@example.com", "password")).rejects.toThrow("Sign out");
});

test("explicit saved sign-in restores through secure runtime auth and applies the same Cloud lifecycle", async () => {
  let authenticated = 0;
  const { cloud, calls, root } = setup({ onCloudAuthenticated: async context => {
    authenticated++;
    expect(context.queueKey).toBe("restored-queue-key");
  } });
  await cloud.restore("saved-refresh-token", "restored-queue-key");
  expect(authenticated).toBe(1);
  expect(cloud.state().authenticated).toBe(true);
  expect(calls).toContainEqual(expect.objectContaining({ path: "/auth/v1/token", body: { refresh_token: "saved-refresh-token" } }));
  const file = readFileSync(join(root, "gamebrowser-settings.json"), "utf8");
  expect(file).not.toContain("saved-refresh-token");
  expect(file).not.toContain("restored-queue-key");
});

test("saved native device credentials restore the existing device without bootstrapping a new lease owner", async () => {
  const { cloud, calls } = setup();
  await cloud.restore("saved-refresh", "queue-key", "saved-device-secret");
  expect(cloud.context()?.connection.deviceId()).toBe("device");
  expect(cloud.context()?.connection.deviceCredential()).toBe("saved-device-secret");
  expect(calls.some(call => call.path === "/v1/account/bootstrap")).toBe(false);
  expect(calls.some(call => call.path === "/v1/status")).toBe(true);
});

test("unconfirmed Cloud capture preserves authentication so owned browsers can be recovered safely", async () => {
  const retained = Object.assign(new Error("Owned browser teardown remains unconfirmed"), { retainCloudAuthentication: true });
  const { cloud, calls } = setup({ onCloudAuthenticated: async () => { throw retained; } });
  await expect(cloud.signIn("owner@example.com", "password")).rejects.toBe(retained);
  expect(cloud.state().authenticated).toBe(true);
  expect(cloud.context()?.connection.deviceCredential()).toBe("fixture-device-secret");
  expect(calls.some(call => call.path === "/auth/v1/logout")).toBe(false);
});
