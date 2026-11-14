import { afterEach, expect, test } from "bun:test";
import { ProfileStore } from "../store.ts";
import { buildNewProfile } from "../create.ts";
import { decodePortableProfile, encodePortableProfile } from "../portable-profile.ts";
import { parseImportFile } from "../import-formats.ts";
import type { CloudProfileSummary, PortableProfile } from "../contracts/cloud-v1.ts";
import type { StandaloneCloudContext } from "./cloud.ts";
import { createCloudProfileRoutes, type StandaloneCloudProfileContext } from "./cloud-profiles.ts";

const stores: ProfileStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture() {
  const store = new ProfileStore(":memory:"); stores.push(store);
  const profile = { ...buildNewProfile({ engine: "firefox", name: "Remote profile", group: "Team", screen: "1280x720" }, () => false), id: "p1", password: "cloud-password",
    cookies: [{ name: "session", value: "cloud-cookie", domain: ".example.com", path: "/" }] };
  store.upsertProfile(profile);
  let payload = encodePortableProfile(profile), current = true, role = "owner";
  let summary: CloudProfileSummary = { id: "p1", name: profile.name, group: "Team", platform: "", tags: [], version: 1, trashedAt: null, trashedBy: null, updatedAt: 1, activeOpens: [], permission: "edit" };
  let visible = true, refreshes = 0;
  const calls: Array<{ path: string; method: string; body: any }> = [];
  const imported: unknown[] = [];
  const context = {
    auth: { accessTokenOrRefresh: async () => "token" },
    connection: { accountId: () => "account", deviceCredential: () => "device" },
    configuration: { baseUrl: "https://cloud.example.test", authUrl: "https://cloud.example.test", anonKey: "public" }, generation: 1, current: () => current,
    fetchFn: async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname, method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path, method, body });
      if (path === "/v1/status") return Response.json({ ok: true, account: { id: "account" }, workspace: { role } });
      if (path === "/v1/profiles") return Response.json({ ok: true, profiles: visible ? [summary] : [] });
      if (path === "/v1/profiles/p1" && method === "GET") return Response.json({ ok: true, profile: summary, payload });
      if (path === "/v1/profiles/p1" && method === "PATCH") {
        expect(body.expectedVersion).toBe(summary.version);
        payload = body.payload; summary = { ...summary, version: summary.version + 1 };
        return Response.json({ ok: true, profile: summary, payloadDigest: "digest" });
      }
      if (path === "/v1/profiles/p1/trash") { summary = { ...summary, trashedAt: 123, version: summary.version + 1 }; return Response.json({ ok: true }); }
      if (path === "/v1/profiles/p1/restore") { summary = { ...summary, trashedAt: null, version: summary.version + 1 }; return Response.json({ ok: true }); }
      if (path === "/v1/profiles/p1/purge") { visible = false; return Response.json({ ok: true }); }
      if (path === "/v1/workspace/folders") return Response.json({ ok: true, folders: [{ name: "Team", archivedAt: null, permission: "edit", extensionDefaults: [] }] });
      throw new Error(`Unexpected Cloud mock ${method} ${path}`);
    },
  } as unknown as StandaloneCloudContext;
  const workspace = { refreshProfiles: () => { refreshes++; }, library: { listGroups: () => [{ id: "group-team", name: "Team" }] } } as unknown as StandaloneCloudProfileContext["workspace"];
  const coordinator = { listRoster: async () => ({ profiles: [], healthSources: [] }), importProfiles: async (group: string, profiles: unknown[]) => { imported.push({ group, profiles }); return { ok: true, imported: profiles.length, ids: ["p1"] }; } } as unknown as StandaloneCloudProfileContext["coordinator"];
  const handler = createCloudProfileRoutes(() => current ? { context, store, workspace, coordinator } : undefined);
  const request = async (path: string, body?: unknown) => (await handler(new Request(`http://127.0.0.1:8080/workspace/api/app/${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { "x-stakemode-workspace": "1", authorization: "Bearer token", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), "127.0.0.1"))!;
  return { store, profile, request, handler, calls, imported, context,
    getPayload: () => payload, revoke: () => { visible = false; }, viewOnly: () => { summary = { ...summary, permission: "view" }; },
    setRole: (value: string) => { role = value; }, changeAccount: () => { current = false; }, getRefreshes: () => refreshes };
}

test("Cloud device settings/order use the Cloud store and current roster; revoked cache cannot authorize edits", async () => {
  const { store, request, revoke, profile, calls } = fixture();
  expect((await request("profiles/p1/resources", { ramBudgetMb: null, autoOptimize: true, alwaysShowBookmarks: true })).status).toBe(200);
  expect(store.getProfileResourcePolicy("p1")).toEqual({ ramBudgetMb: null, autoOptimize: true, alwaysShowBookmarks: true });
  expect((await request("profile-order", { ids: ["p1"] })).status).toBe(200);
  expect(store.getProfileOrder("cloud:account")).toEqual(["p1"]);
  expect(store.getProfileOrder("local")).toEqual([]);
  revoke();
  expect((await request("profiles/p1/resources", { ramBudgetMb: 1024, autoOptimize: false })).status).toBe(404);
  expect(store.getProfileResourcePolicy("p1").ramBudgetMb).toBeNull();
  expect(store.getProfile("p1")?.fingerprintSeed).toBe(profile.fingerprintSeed);
  expect(calls.filter(call => call.path === "/v1/status")).toHaveLength(3);
  expect(calls.filter(call => call.path === "/v1/profiles")).toHaveLength(3);
});

test("Cloud identity edits preserve secrets/session and use explicit version checks", async () => {
  const { request, getPayload } = fixture();
  const detail = await request("profiles/p1/identity").then(response => response.json());
  expect(detail.profile.expectedVersion).toBe(1);
  expect(detail.profile.password).toBeUndefined();
  const edited = await request("profiles/p1/identity", { expectedVersion: 1, set: { timezone: "Africa/Lagos", locale: "en-NG" } });
  expect(edited.status).toBe(200);
  expect((await edited.json()).profile.expectedVersion).toBe(2);
  const decoded = decodePortableProfile(getPayload());
  expect(decoded.profile).toMatchObject({ timezone: "Africa/Lagos", locale: "en-NG", password: "cloud-password" });
  expect(decoded.profile.cookies[0]?.value).toBe("cloud-cookie");
  expect((await request("profiles/p1/identity", { expectedVersion: 1, set: { name: "stale" } })).status).toBe(409);
});

test("Cloud exports read the authoritative payload and preserve all full import formats", async () => {
  const { request } = fixture();
  for (const format of ["txt", "xlsx", "json"]) {
    const response = await request("profiles/export", { ids: ["p1"], format });
    expect(response.status).toBe(200);
    const parsed = await parseImportFile(`cloud.${format}`, new Uint8Array(await response.arrayBuffer()));
    expect(parsed.profiles[0]).toMatchObject({ id: "p1", password: "cloud-password", cookies: [{ value: "cloud-cookie" }] });
  }
});

test("Cloud Trash is recoverable and permanent deletion requires owner permission", async () => {
  const { request, setRole, calls } = fixture();
  expect(await request("profiles/trash", { ids: ["p1"] }).then(response => response.json())).toMatchObject({ results: [{ status: "trashed" }] });
  expect((await request("trash").then(response => response.json())).profiles[0]).toMatchObject({ id: "p1", canRestore: true, canPurge: true });
  setRole("admin");
  expect(await request("trash/purge", { ids: ["p1"] }).then(response => response.json())).toMatchObject({ results: [{ status: "failed", code: "owner_only" }] });
  expect(calls.some(call => call.path.endsWith("/purge"))).toBe(false);
  expect(await request("trash/restore", { ids: ["p1"] }).then(response => response.json())).toMatchObject({ results: [{ status: "restored" }] });
});

test("Cloud imports validate writable destination folders and delegate to the Cloud coordinator", async () => {
  const { handler, imported, request } = fixture();
  const exported = await request("profiles/export", { ids: ["p1"], format: "txt" });
  const form = new FormData(); form.append("files", new File([await exported.arrayBuffer()], "profiles.txt")); form.append("groupId", "group-team");
  const response = await handler(new Request("http://127.0.0.1:8080/workspace/api/app/profiles/import", {
    method: "POST", headers: { "x-stakemode-workspace": "1", authorization: "Bearer token" }, body: form,
  }), "127.0.0.1");
  expect(response?.status).toBe(200);
  expect(imported).toMatchObject([{ group: "Team", profiles: [{ id: "p1", password: "cloud-password" }] }]);
});

test("Cloud profile operations reject view-only device edits and account changes", async () => {
  const { request, viewOnly, changeAccount } = fixture();
  viewOnly();
  expect((await request("profiles/p1/resources", { ramBudgetMb: null, autoOptimize: true })).status).toBe(403);
  expect((await request("profiles/p1/identity", { set: { name: "overwrite" } })).status).toBe(403);
  expect((await request("profiles/export", { ids: ["p1"], format: "txt" })).status).toBe(403);
  changeAccount();
  expect((await request("profiles/export", { ids: ["p1"], format: "txt" })).status).toBe(401);
});
