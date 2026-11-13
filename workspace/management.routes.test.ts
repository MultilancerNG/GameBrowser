import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProfileStore } from "../store.ts";
import { StakeModeWorkspace } from "./server.ts";

async function fixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), "stakemode-management-"));
  const store = new ProfileStore(join(stateRoot, "profiles.sqlite"));
  const removed: string[] = [];
  const workflowEvents: string[] = [];
  const launcher: any = { start: async () => { throw new Error("Native launches are outside this route fixture"); }, stop: async (id: string) => { store.clearLaunch(id); return true; },
    profileDeletionBlocked: () => false, removeProfileData: async (id: string, after: () => Promise<void>) => { removed.push(id); await after(); } };
  const bridge: any = { start() {}, stop: async () => {}, detach: async () => {}, forgetProfile: async () => {}, setVisible() {},
    executeWorkflowStep: async (_id: string, step: any) => { workflowEvents.push(step.kind); return step.kind === "extract" ? "opaque-fixture-output" : undefined; } };
  const workspace = new StakeModeWorkspace({ stateRoot, store, launcher, bridgeFactory: () => bridge });
  let token = "";
  const request = (path: string, method = "GET", body?: unknown, authenticated = true) => new Request(`http://127.0.0.1:8080/workspace/api/${path}`, {
    method, headers: { host: "127.0.0.1:8080", "x-stakemode-workspace": "1", ...(authenticated && token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const api = async (path: string, method = "GET", body?: unknown, authenticated = true) => {
    const response = await workspace.handleRequest(request(path, method, body, authenticated), "127.0.0.1");
    return { status: response.status, body: await response.json() };
  };
  token = (await api("bootstrap")).body.token;
  const close = async () => { await workspace.stop(); store.close(); rmSync(stateRoot, { recursive: true, force: true }); };
  return { workspace, store, removed, api, close, stateRoot, workflowEvents };
}

test("management routes authenticate before importing files or revealing saved bookmarks", async () => {
  const f = await fixture();
  try {
    expect((await f.api("extensions/import", "POST", { path: "/sensitive/path", engine: "chromium" }, false)).status).toBe(401);
    expect((await f.api("library", "GET", undefined, false)).status).toBe(401);
    const [profile] = await f.workspace.manager.bulkCreate({ count: 1, urls: ["https://example.test/"] });
    const group = (await f.api("library/groups", "POST", { name: "Research" })).body.group;
    const updated = await f.api(`library/profiles/${profile!.id}`, "POST", { groupId: group.id, tags: ["one", "two"], notes: "Example notes", bookmarks: [{ title: "Search", url: "https://example.test/?query=deliberate-bookmark" }] });
    expect(updated.status).toBe(200);
    expect(updated.body.metadata.tags).toEqual(["one", "two"]);
    expect(JSON.stringify(updated.body.snapshot)).not.toContain("deliberate-bookmark");
    expect((await f.api(`library/profiles/${profile!.id}`)).body.metadata.bookmarks[0].url).toContain("deliberate-bookmark");
    expect((await f.api(`library/groups/${group.id}`, "DELETE")).status).toBe(200);
    const retained = (await f.api(`library/profiles/${profile!.id}`)).body.metadata;
    expect(retained.groupId).toBeNull(); expect(retained.tags).toEqual(["one", "two"]); expect(retained.bookmarks).toHaveLength(1);
  } finally { await f.close(); }
});

test("configuration export/import creates fresh identities and never transfers account or proxy credentials", async () => {
  const f = await fixture();
  try {
    const [source] = await f.workspace.manager.bulkCreate({ count: 1, urls: ["https://example.test/"], proxies: ["http://proxy-user:proxy-secret@proxy.test:9000"], networkMode: "proxy" });
    const original = f.store.getProfile(source!.id)!;
    f.store.upsertProfiles([{ ...original, username: "private-account", password: "private-account-secret" }]);
    await f.api(`library/profiles/${source!.id}`, "POST", { tags: ["backup"], notes: "Retained note", bookmarks: [{ title: "Home", url: "https://example.test/" }] });
    const exported = await f.api(`library/export?ids=${source!.id}`);
    expect(exported.status).toBe(200);
    const serialized = JSON.stringify(exported.body.document);
    for (const secret of [source!.id, "private-account", "proxy-user", "proxy-secret", original.fingerprintSeed]) expect(serialized).not.toContain(String(secret));
    const imported = await f.api("library/import", "POST", { document: exported.body.document });
    expect(imported.status).toBe(200);
    const target = imported.body.profiles[0];
    expect(target.id).not.toBe(source!.id); expect(target.networkMode).toBe("proxy");
    const fresh = f.store.getProfile(target.id)!;
    expect(fresh.fingerprintSeed).not.toBe(original.fingerprintSeed);
    expect(fresh.username).toBe(""); expect(fresh.password).toBe("");
    expect(fresh.proxy?.user).toBe(""); expect(fresh.proxy?.pass).toBe("");
    expect(existsSync(join(f.stateRoot, "profiles", target.id))).toBe(false);
    const metadata = (await f.api(`library/profiles/${target.id}`)).body.metadata;
    expect(metadata.tags).toEqual(["backup"]); expect(metadata.bookmarks).toHaveLength(1);
    const invalid = structuredClone(exported.body.document); invalid.profiles[0].proxy.user = "do-not-copy";
    const before = f.workspace.manager.list().length;
    expect((await f.api("library/import", "POST", { document: invalid })).status).toBe(400);
    expect(f.workspace.manager.list()).toHaveLength(before);
  } finally { await f.close(); }
});

test("custom desktop screen routes require authentication and stopped profiles, and templates keep exact geometry", async () => {
  const f = await fixture();
  try {
    for (const engine of ["chromium", "firefox"] as const) {
      const [profile] = await f.workspace.manager.bulkCreate({ count: 1, engine, resolutions: ["1473x913"] });
      const route = `profiles/${profile!.id}/screen`, geometry = { width: 2049, height: 1153 };
      expect((await f.api(route, "POST", geometry, false)).status).toBe(401);
      expect((await f.api(route)).status).toBe(405);
      const identityBefore = f.store.getProfile(profile!.id)!;
      expect((await f.api(route, "POST", { width: 390, height: 844 })).status).toBe(200);
      const resized = f.store.getProfile(profile!.id)!;
      expect(resized.screenWidth).toBe(390); expect(resized.screenHeight).toBe(844);
      expect(resized.ua).toBe(identityBefore.ua); expect(resized.platformOs).toBe(identityBefore.platformOs);
      expect(resized.fingerprintSeed).toBe(identityBefore.fingerprintSeed); expect(resized.cookies).toEqual(identityBefore.cookies);
      const changed = await f.api(route, "POST", geometry);
      expect(changed.status).toBe(200); expect(changed.body.profile).toMatchObject({ screenWidth: 2049, screenHeight: 1153 });
      const exported = await f.api(`library/export?ids=${profile!.id}`);
      expect(exported.status).toBe(200); expect(exported.body.document.profiles[0]).toMatchObject({ screenWidth: 2049, screenHeight: 1153 });
      const imported = await f.api("library/import", "POST", { document: exported.body.document });
      expect(imported.status).toBe(200); expect(imported.body.profiles[0]).toMatchObject({ screenWidth: 2049, screenHeight: 1153 });
      const importedProfile = f.store.getProfile(imported.body.profiles[0].id)!;
      expect(importedProfile.id).not.toBe(profile!.id);
      if (engine === "firefox") expect(importedProfile.firefox?.config).toMatchObject({ "screen.width": 2049, "screen.height": 1153, "window.innerWidth": 2049, "window.innerHeight": 1153 });
      f.store.recordLaunch({ profileId: profile!.id, engine, pid: 1234, debugPort: 9222, startedAt: Date.now(), ws: "ws://127.0.0.1:9222/fixture", headless: true });
      expect((await f.api(route, "POST", { width: 1920, height: 1080 })).status).toBe(409);
      expect(f.store.getProfile(profile!.id)?.screenWidth).toBe(2049);
      await f.workspace.manager.stop(profile!.id);
    }
    expect((await f.api("profiles/missing/screen", "POST", { width: 1473, height: 913 })).status).toBe(404);
  } finally { await f.close(); }
});

test("batch metadata merges selected fields and confirmed deletion removes only selected local records", async () => {
  const f = await fixture();
  try {
    const profiles = await f.workspace.manager.bulkCreate({ count: 2, urls: ["https://example.test/"] });
    for (const p of profiles) await f.api(`library/profiles/${p.id}`, "POST", { tags: ["keep"], notes: p.id, bookmarks: [{ title: "Home", url: "https://example.test/" }] });
    const group = (await f.api("library/groups", "POST", { name: "Batch" })).body.group;
    const ids = profiles.map(p => p.id);
    const batch = await f.api("batch", "POST", { action: "metadata", profileIds: ids, metadata: { groupId: group.id } });
    expect(batch.status).toBe(200); expect(batch.body.results.every((r: any) => r.ok)).toBe(true);
    const merged = (await f.api(`library/profiles/${ids[0]}`)).body.metadata;
    expect(merged.tags).toEqual(["keep"]); expect(merged.notes).toBe(ids[0]); expect(merged.bookmarks).toHaveLength(1);
    expect((await f.api("batch", "POST", { action: "delete", profileIds: [ids[0]], confirmation: "wrong" })).status).toBe(400);
    expect(f.removed).toHaveLength(0);
    expect((await f.api("batch", "POST", { action: "delete", profileIds: [ids[0]], confirmation: "DELETE 1 PROFILES" })).status).toBe(200);
    expect(f.removed).toEqual([ids[0]!]); expect(f.workspace.manager.getProfile(ids[0]!)).toBeNull();
    expect((await f.api(`library/profiles/${ids[0]}`)).status).toBe(400);
    expect((await f.api(`library/profiles/${ids[1]}`)).body.metadata.tags).toEqual(["keep"]);
    expect(f.workspace.relay.tokenFor(ids[0]!)).toBeUndefined();
  } finally { await f.close(); }
});

test("valid imported 128-character profile IDs retain all profile management routes", async () => {
  const f = await fixture();
  try {
    const [source] = await f.workspace.manager.bulkCreate({ count: 1 });
    const id = "imported_" + "p".repeat(119);
    expect(id).toHaveLength(128);
    f.store.upsertProfile({ ...f.store.getProfile(source!.id)!, id, fingerprintSeed: 99112233 });
    const renamed = await f.api(`profiles/${id}/rename`, "POST", { name: "Long imported identity" });
    expect(renamed.status).toBe(200); expect(renamed.body.profile.id).toBe(id);
    expect((await f.api(`profiles/${id}/screen`, "POST", { width: 390, height: 844 })).status).toBe(200);
    expect((await f.api(`profiles/${id}/extensions`)).status).toBe(200);
    expect((await f.api(`library/profiles/${id}`, "POST", { tags: ["imported"], notes: "Keep long identity" })).status).toBe(200);
    expect((await f.api(`library/profiles/${id}`)).body.metadata.tags).toEqual(["imported"]);
    const copied = await f.api(`profiles/${id}/copy`, "POST", { name: "Isolated copy" });
    expect(copied.status).toBe(200); expect(copied.body.profile.id).not.toBe(id);
    expect((await f.api("profiles/CON/rename", "POST", { name: "Invalid" })).status).toBe(400);
    expect((await f.api(`library/profiles/${id}x`)).status).toBe(400);
  } finally { await f.close(); }
});

test("explicit batch browser close preserves the selected Admin and follower roles", async () => {
  const f = await fixture();
  try {
    const profiles = await f.workspace.manager.bulkCreate({ count: 2, urls: ["https://example.test/"] });
    const [admin, follower] = profiles;
    f.workspace.relay.setRole(admin!.id, "admin");
    f.workspace.relay.setRole(follower!.id, "follower");
    f.store.recordLaunch({ profileId: follower!.id, pid: 1234, debugPort: 9222, startedAt: Date.now(), ws: "ws://127.0.0.1:9222/fixture", headless: true });
    const stopped = await f.api("batch", "POST", { action: "stop", profileIds: [follower!.id] });
    expect(stopped.status).toBe(200); expect(stopped.body.results[0].ok).toBe(true);
    expect(f.store.getLaunch(follower!.id)).toBeNull();
    expect(f.workspace.relay.configFor(admin!.id)?.role).toBe("admin");
    expect(f.workspace.relay.configFor(follower!.id)?.role).toBe("follower");
  } finally { await f.close(); }
});

test("read-only jobs require independent manual control and expose outputs only through authenticated explicit reads", async () => {
  const f = await fixture();
  try {
    const [profile] = await f.workspace.manager.bulkCreate({ count: 1, urls: ["https://example.test/"] });
    const id = profile!.id;
    f.store.recordLaunch({ profileId: id, pid: 1001, debugPort: 9222, startedAt: Date.now(), ws: "ws://127.0.0.1:9222/fixture", headless: true });
    const saved = await f.api("workflows", "POST", { name: "Inspect fixture", steps: [{ kind: "extract", source: "title", field: "title" }] });
    expect(saved.status).toBe(200);
    const workflowId = saved.body.workflow.id;
    await f.api("role", "POST", { profileId: id, role: "admin" });
    const refused = await f.api(`workflows/${workflowId}/run`, "POST", { profileIds: [id] });
    expect(refused.body.jobs).toHaveLength(0); expect(refused.body.rejected).toHaveLength(1); expect(f.workflowEvents).toHaveLength(0);
    await f.api("manual", "POST", { profileId: id, enabled: true });
    const started = await f.api(`workflows/${workflowId}/run`, "POST", { profileIds: [id] });
    const jobId = started.body.jobs[0].id;
    for (let i = 0; i < 20 && f.workspace.workflows.getJob(jobId).status !== "completed"; i++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(f.workspace.workflows.getJob(jobId).status).toBe("completed");
    expect((await f.api(`jobs/${jobId}/output`, "GET", undefined, false)).status).toBe(401);
    const output = await f.api(`jobs/${jobId}/output?format=json`);
    expect(JSON.parse(output.body.content).values.title).toBe("opaque-fixture-output");
    expect(JSON.stringify(f.workspace.snapshot())).not.toContain("opaque-fixture-output");
    expect(JSON.stringify((await f.api("jobs")).body)).not.toContain("opaque-fixture-output");
    expect((await f.api("workflows", "POST", { name: "Forbidden", steps: [{ kind: "click", selector: "button" }] })).status).toBe(400);
    await f.workspace.manager.stop(id);
    expect((await f.api(`profiles/${id}`, "DELETE", { confirmation: id })).status).toBe(200);
    expect((await f.api("jobs")).body.jobs).toHaveLength(0);
  } finally { await f.close(); }
});
