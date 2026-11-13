import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Launcher } from "../launcher.ts";
import { ProfileStore } from "../store.ts";
import { ProcessManager } from "./processManager.ts";
import { MAX_PROXY_IMPORT_BYTES, ProxyLibrary } from "./proxyLibrary.ts";
import { handleProxyRoute } from "./proxyRoutes.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "stakemode-proxy-library-"));
  const library = new ProxyLibrary(root), file = join(root, "workspace", "proxies.json");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, library, file };
}
function profileFixture() {
  const f = fixture(), store = new ProfileStore(join(f.root, "profiles.sqlite"));
  const launcher = new Launcher({ store, dataRoot: join(f.root, "profiles"), unsafeDisableIdentityGates: true });
  const manager = new ProcessManager({ store, launcher, stateRoot: f.root, warmProcessService: async () => true, monitorFactory: () => ({ start() {}, dispose() {} }) });
  cleanups.unshift(() => { manager.dispose(); store.close(); });
  return { ...f, store, manager };
}
const secretProxy = "http://private-route-user:private-route-password@proxy.example.test:8080";
const secretValues = ["private-route-user", "private-route-password"];
function expectPrivate(value: unknown) { for (const secret of secretValues) expect(JSON.stringify(value)).not.toContain(secret); }

test("bulk proxy import uses canonical formats, persists private authentication, and returns only metadata", () => {
  const f = fixture();
  const imported = f.library.importText(`${secretProxy}\r\nbeta.proxy.test:3128:legacy-user:colon:password\n\n socks5://socks-user:socks%3Apassword@[2001:db8::1]:1080\nhttps://secure.proxy.test:8443`, "Europe");
  expect(imported.map(proxy => proxy.type)).toEqual(["http", "http", "socks5", "https"]);
  expect(imported.map(proxy => proxy.authenticated)).toEqual([true, true, true, false]);
  expect(imported.every(proxy => proxy.group === "Europe")).toBe(true);
  expectPrivate(imported); expectPrivate(f.library.get(imported[0]!.id));
  const stored = JSON.parse(readFileSync(f.file, "utf8"));
  expect(stored.proxies[0].proxy).toMatchObject({ user: secretValues[0], pass: secretValues[1] });
  expect(stored.proxies[1].proxy.pass).toBe("colon:password");
  expect(stored.proxies[2].proxy).toMatchObject({ host: "2001:db8::1", pass: "socks:password" });
  expect(new ProxyLibrary(f.root).list()).toEqual(imported);
  if (process.platform !== "win32") expect(statSync(f.file).mode & 0o777).toBe(0o600);
});
test("imports validate all lines and capacity before committing any saved proxy", () => {
  const f = fixture(); f.library.create({ alias: "Existing", proxy: secretProxy });
  const before = readFileSync(f.file, "utf8");
  expect(() => f.library.importText(`valid.proxy.test:8080\nsocks4://private-route-user:private-route-password@bad.proxy.test:9000`)).toThrow("line 2 is invalid");
  expect(readFileSync(f.file, "utf8")).toBe(before); expect(f.library.list()).toHaveLength(1);
  expect(() => f.library.importText("x".repeat(MAX_PROXY_IMPORT_BYTES + 1))).toThrow("at most 1 MB");
  expect(() => f.library.importText(Array.from({ length: 256 }, () => "bulk.proxy.test:8080").join("\n"))).toThrow("saved proxy limit");
  expect(() => f.library.create({ alias: "Unsupported", proxy: "https://private-route-user:private-route-password@secure.proxy.test:8443" })).toThrow("Authenticated HTTPS");
  expect(() => f.library.create({ alias: "Bad", proxy: { type: "http", host: "proxy.example.test", port: "8080", user: "u\n", pass: "p" } })).toThrow();
  expect(() => f.library.create({ alias: "Raw control", proxy: "http://user:pass@proxy.example.test:8080\n" })).toThrow();
  expect(() => f.library.create({ alias: "Encoded control", proxy: "http://user%0A:pass%0D@proxy.example.test:8080" })).toThrow();
  expect(readFileSync(f.file, "utf8")).toBe(before);
});
test("saved alias edits preserve authentication and assigned profiles retain independent copies after registry edits/deletion", async () => {
  const f = profileFixture(), [profile] = await f.manager.bulkCreate({ count: 1 });
  const saved = f.library.create({ alias: "Primary", group: "Region A", proxy: secretProxy });
  expect(f.library.update(saved.id, { alias: "Renamed", group: "Region B" })).toMatchObject({ alias: "Renamed", group: "Region B", authenticated: true });
  expect(f.library.assign(saved.id, [profile!.id], f.manager)).toEqual([{ profileId: profile!.id, success: true }]);
  expect(f.store.getProfile(profile!.id)?.proxy).toMatchObject({ user: secretValues[0], pass: secretValues[1] });
  expect(f.manager.getProfile(profile!.id)?.networkMode).toBe("proxy"); expectPrivate(f.manager.list());
  f.library.update(saved.id, { proxy: "socks5://replacement:replacement-secret@new.proxy.test:1080" });
  f.library.delete(saved.id); expect(f.library.list()).toEqual([]);
  expect(f.store.getProfile(profile!.id)?.proxy).toMatchObject({ host: "proxy.example.test", user: secretValues[0], pass: secretValues[1] });
});
test("assignment rejects any active or unknown selected profile before changing stopped peers", async () => {
  const f = profileFixture(), [stopped, active] = await f.manager.bulkCreate({ count: 2 });
  const proxy = f.library.create({ alias: "Assignment", proxy: secretProxy });
  f.store.recordLaunch({ profileId: active!.id, pid: 9123, debugPort: 9222, ws: "ws://localhost:9222", startedAt: Date.now() });
  expect(() => f.library.assign(proxy.id, [stopped!.id, active!.id], f.manager)).toThrow("Stop all selected profiles");
  expect(f.store.getProfile(stopped!.id)?.proxy).toBeNull();
  expect(() => f.library.assign(proxy.id, [stopped!.id, "missing-profile"], f.manager)).toThrow("not found");
  expect(f.store.getProfile(stopped!.id)?.proxy).toBeNull();
  expect(() => f.library.assign(proxy.id, [stopped!.id, stopped!.id], f.manager)).toThrow("distinct");
});
test("private storage refuses corruption, symbolic links and failed writes without applying in-memory changes", () => {
  const f = fixture(), proxy = f.library.create({ alias: "Retained", proxy: secretProxy });
  const outside = join(f.root, "outside.json"); writeFileSync(outside, "untouched"); rmSync(f.file);
  symlinkSync(outside, f.file);
  expect(() => f.library.update(proxy.id, { alias: "Changed" })).toThrow("no saved proxy changes");
  expect(f.library.get(proxy.id).alias).toBe("Retained"); expect(readFileSync(outside, "utf8")).toBe("untouched");
  expect(() => new ProxyLibrary(f.root)).toThrow("unavailable or invalid");
  rmSync(f.file); writeFileSync(f.file, '{"version":1,"proxies":[{"proxy":"private-route-password"}]}');
  try { new ProxyLibrary(f.root); throw new Error("Expected storage rejection"); }
  catch (error) { expectPrivate({ error: String(error) }); }
});
test("aliases, identifiers and unsupported input fields are bounded without returning submitted secrets", () => {
  const f = fixture(); f.library.create({ alias: "Distinct alias", proxy: secretProxy });
  expect(() => f.library.create({ alias: " distinct ALIAS ", proxy: "proxy.test:8080" })).toThrow("already exists");
  expect(() => f.library.create({ alias: "x".repeat(81), proxy: secretProxy })).toThrow("80 printable");
  expect(() => f.library.create({ alias: "Other", proxy: secretProxy, exportCredentials: true })).toThrow("unsupported field");
  expect(() => f.library.delete("../../private-route-password")).toThrow("ID is invalid");
  expect(() => f.library.get("proxy_" + "f".repeat(32))).toThrow("not found");
  const directoryRoot = join(f.root, "invalid-root"); mkdirSync(directoryRoot); mkdirSync(join(directoryRoot, "workspace")); writeFileSync(join(directoryRoot, "workspace", "proxies.json"), "invalid-private-route-password");
  expect(() => new ProxyLibrary(directoryRoot)).toThrow("unavailable or invalid");
});
test("authenticated route handler returns credential-free CRUD/import/assignment responses and masks underlying errors", async () => {
  const f = profileFixture(), [profile] = await f.manager.bulkCreate({ count: 1 }); let changes = 0;
  const options = { library: f.library, manager: f.manager, changed: () => { changes++; }, snapshot: () => ({ profiles: f.manager.list() }) };
  const request = async (path: string, method = "GET", body?: unknown) => {
    const req = new Request(`http://127.0.0.1:8080/workspace/api/${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
    return await handleProxyRoute(req, new URL(req.url), options);
  };
  const created = await request("proxies", "POST", { alias: "Route proxy", proxy: secretProxy }); expect(created?.status).toBe(201);
  const createdBody = await created!.json() as any; expectPrivate(createdBody); const id = createdBody.proxy.id;
  expectPrivate(await (await request("proxies"))!.json());
  const assigned = await request(`proxies/${id}/assign`, "POST", { profileIds: [profile!.id] });
  const assignedBody = await assigned!.json() as any; expect(assignedBody.results).toEqual([{ profileId: profile!.id, success: true }]); expectPrivate(assignedBody);
  expect((await request(`proxies/${id}`, "PATCH", { alias: "Updated route alias" }))?.status).toBe(200);
  const rejected = await request("proxies/import", "POST", { text: "socks4://private-route-user:private-route-password@invalid.test:8000" });
  expect(rejected?.status).toBe(400); expectPrivate(await rejected!.json());
  const rawRequest = new Request(`http://127.0.0.1:8080/workspace/api/proxies/${id}/assign`, { method: "POST", body: JSON.stringify({ profileIds: [profile!.id] }) });
  const failed = await handleProxyRoute(rawRequest, new URL(rawRequest.url), { ...options, manager: { ...f.manager, getProfile: f.manager.getProfile.bind(f.manager), canEditProfile: () => true,
    updateNetwork: () => { throw new Error(secretProxy); }, list: () => [] } });
  expectPrivate(await failed!.json());
  expect((await request(`proxies/${id}`, "DELETE"))?.status).toBe(200); expect(f.store.getProfile(profile!.id)?.proxy?.pass).toBe(secretValues[1]);
  expect(changes).toBe(5);
  expect((await request("proxies", "PUT"))?.status).toBe(405);
  expect(await request("some-unrelated-route")).toBeUndefined();
});
test("proxy routes bound raw request bodies and reject all-active assignments with a conflict response", async () => {
  const f = profileFixture(), [profile] = await f.manager.bulkCreate({ count: 1 });
  const saved = f.library.create({ alias: "Stopped only", proxy: secretProxy });
  f.store.recordLaunch({ profileId: profile!.id, pid: 9123, debugPort: 9222, ws: "ws://localhost:9222", startedAt: Date.now() });
  const options = { library: f.library, manager: f.manager };
  const request = new Request(`http://127.0.0.1:8080/workspace/api/proxies/${saved.id}/assign`, { method: "POST", body: JSON.stringify({ profileIds: [profile!.id] }) });
  const rejected = await handleProxyRoute(request, new URL(request.url), options); expect(rejected?.status).toBe(409); expectPrivate(await rejected!.json());
  const oversized = new Request("http://127.0.0.1:8080/workspace/api/proxies/import", { method: "POST", body: "x".repeat(MAX_PROXY_IMPORT_BYTES + 1) });
  expect((await handleProxyRoute(oversized, new URL(oversized.url), options))?.status).toBe(400);
});
