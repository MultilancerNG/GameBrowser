import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore } from "../store.ts";
import { buildNewProfile } from "../create.ts";
import type { Launcher } from "../launcher.ts";
import { parseImportFile } from "../import-formats.ts";
import { createStandaloneServices } from "./services.ts";
import { AGENT_CONTROL_PROTOCOL } from "../agent-control.ts";

const fixtures: Array<{ store: ProfileStore; root: string; close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) { await fixture.close(); fixture.store.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "gamebrowser-services-"));
  const store = new ProfileStore(":memory:");
  const profile = { ...buildNewProfile({ name: "Preserved", screen: "1280x720" }, () => false), id: "p1", password: "fixture-secret",
    cookies: [{ name: "session", value: "fixture-cookie", domain: ".example.com", path: "/" }] };
  store.upsertProfile(profile);
  const blocked = new Set<string>(), removed: string[] = [];
  const launcher = { profileDeletionBlocked: (id: string) => blocked.has(id), captureLocalSession: async () => false, reconcileOrphans: async () => {},
    cacheCleanupSettled: async () => {}, removeUserDataDir: (id: string) => { removed.push(id); return true; } } as unknown as Launcher;
  const service = createStandaloneServices({ root, store, launcher, nonce: "a".repeat(64) });
  const request = async (path: string, body?: unknown, scope: "local" | "cloud" = "local") => {
    const response = await service.fetch(new Request(`http://127.0.0.1:8080/workspace/api/app/${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { "x-stakemode-workspace": "1", authorization: "Bearer fixture-token", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), "127.0.0.1", scope);
    return response!;
  };
  fixtures.push({ root, store, close: service.close });
  return { root, store, profile, launcher, blocked, removed, service, request };
}

test("own settings default to Local and reject untrusted requests without leaking profile credentials", async () => {
  const { service, request } = setup();
  const state = await request("settings").then(response => response.json());
  expect(state).toMatchObject({ ok: true, mode: "local", cloud: { authenticated: false, configured: false }, localMcp: { enabled: true } });
  expect(JSON.stringify(state)).not.toContain("fixture-secret");
  const denied = await service.fetch(new Request("http://127.0.0.1:8080/workspace/api/app/settings"), "127.0.0.1");
  expect(denied?.status).toBe(403);
  const crossOrigin = await service.fetch(new Request("http://127.0.0.1:8080/workspace/api/app/settings", {
    headers: { "x-stakemode-workspace": "1", authorization: "Bearer token", origin: "https://unrelated.example" },
  }), "127.0.0.1");
  expect(crossOrigin?.status).toBe(403);
});

test("native compatibility editor exposes identity only and mutations require the app API", async () => {
  const { service } = setup();
  const response = await service.fetch(new Request("http://127.0.0.1:8080/ui/api/profiles/p1"), "127.0.0.1");
  const body = await response!.json();
  expect(body.profile).toMatchObject({ id: "p1", name: "Preserved", screenWidth: 1280, screenHeight: 720 });
  expect(body.profile.password).toBeUndefined();
  expect(body.profile.cookies).toBeUndefined();
  expect(await service.fetch(new Request("http://127.0.0.1:8080/ui/api/profiles/p1", { method: "POST" }), "127.0.0.1")).toBeUndefined();
});

test("device RAM/bookmark preferences and profile order never change identity or following plans", async () => {
  const { store, request } = setup();
  const original = store.getProfile("p1");
  store.setBrowserSyncPlan("local", { adminId: "p1", followerIds: ["p2"] });
  expect((await request("profiles/p1/resources", { ramBudgetMb: null, autoOptimize: true, alwaysShowBookmarks: true })).status).toBe(200);
  expect((await request("profiles/p1/resources", { ramBudgetMb: 512, autoOptimize: false })).status).toBe(200);
  expect(store.getProfileResourcePolicy("p1")).toEqual({ ramBudgetMb: 512, autoOptimize: false, alwaysShowBookmarks: true });
  expect(store.getProfile("p1")).toEqual(original);
  expect(store.getBrowserSyncPlan("local")).toEqual({ adminId: "p1", followerIds: ["p2"] });
  expect((await request("profile-order", { ids: ["p1"] })).status).toBe(200);
  expect(await request("profile-order").then(response => response.json())).toEqual({ ok: true, ids: ["p1"] });
  expect((await request("profile-order", { ids: ["missing"] })).status).toBe(400);
});

test("recoverable Trash retains identity and blocks browser data purge while the profile is open", async () => {
  const { store, request, blocked, removed } = setup();
  const original = store.getProfile("p1");
  expect(await request("profiles/trash", { ids: ["p1"] }).then(response => response.json())).toEqual({ ok: true, results: [{ id: "p1", status: "trashed" }] });
  expect(store.getProfile("p1")).toBeNull();
  expect(removed).toEqual([]);
  blocked.add("p1");
  expect(await request("trash/purge", { ids: ["p1"] }).then(response => response.json())).toEqual({ ok: true, results: [{ id: "p1", status: "failed", code: "profile_open" }] });
  blocked.clear();
  await request("trash/restore", { ids: ["p1"] });
  expect(store.getProfile("p1")).toEqual(original);
  await request("profiles/trash", { ids: ["p1"] });
  await request("trash/purge", { ids: ["p1"] });
  expect(store.listTrashed()).toEqual([]);
  expect(removed).toEqual(["p1"]);
});

for (const format of ["txt", "xlsx", "json"] as const) test(`${format} exports retain account credentials/cookies and re-import through the independent API`, async () => {
  const { service, store, request } = setup();
  const exported = await request("profiles/export", { ids: ["p1"], format });
  expect(exported.status).toBe(200);
  const bytes = new Uint8Array(await exported.arrayBuffer());
  const parsed = await parseImportFile(`profiles.${format}`, bytes);
  expect(parsed.profiles[0]).toMatchObject({ id: "p1", password: "fixture-secret", cookies: [{ name: "session", value: "fixture-cookie" }] });
  store.deleteProfile("p1");
  const form = new FormData(); form.append("files", new File([bytes as BlobPart], `profiles.${format}`));
  const imported = await service.fetch(new Request("http://127.0.0.1:8080/workspace/api/app/profiles/import", {
    method: "POST", headers: { "x-stakemode-workspace": "1", authorization: "Bearer token" }, body: form,
  }), "127.0.0.1");
  expect(imported?.status).toBe(200);
  expect(store.getProfile("p1")).toMatchObject({ password: "fixture-secret", cookies: [{ name: "session", value: "fixture-cookie" }] });
});

test("Cloud listener cannot use local identity, export, Trash or device preferences", async () => {
  const { store, request } = setup();
  for (const [path, body] of [["profiles/p1/identity", { set: { name: "leak" } }], ["profiles/export", { ids: ["p1"], format: "txt" }], ["trash", undefined], ["profiles/p1/resources", undefined]] as const) {
    expect((await request(path, body, "cloud")).status).toBe(409);
  }
  expect(store.getProfile("p1")?.name).toBe("Preserved");
});

test("local MCP uses native nonce authentication and disabling it fences existing sessions", async () => {
  const { service, request } = setup();
  const auth = new Request("http://127.0.0.1:8080/api/agent/v1/connect", { headers: { authorization: `Bearer ${"a".repeat(64)}` } });
  expect(service.agent.authorize(auth)).toBe(true);
  const session = service.agent.connect();
  const listed = await session.enqueue(JSON.stringify({ protocol: AGENT_CONTROL_PROTOCOL, id: 1, method: "profiles.list" }));
  expect(listed).toMatchObject({ ok: true, result: { profiles: [{ id: "p1", name: "Preserved" }] } });
  await request("local-mcp", { enabled: false });
  expect(service.agent.authorize(auth)).toBe(false);
  expect(() => service.agent.connect()).toThrow("unavailable");
  const persisted = readFileSync(join(fixtures.at(-1)!.root, "gamebrowser-settings.json"), "utf8");
  expect(persisted).not.toContain("fixture-secret");
  expect(persisted).not.toContain("Bearer");
});
