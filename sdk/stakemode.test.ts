import { expect, test } from "bun:test";
import { StakeModeClient, StakeModeError, GameBrowserClient, GameBrowserError } from "./stakemode.ts";
const tokenA = "A".repeat(43), tokenB = "B".repeat(43);
const bootstrap = (token = tokenA) => Response.json({ token, snapshot: { profiles: [{ id: "p1" }] } });
function mockClient(replies: Array<Response | (() => Promise<Response>)>, timeoutMs = 30000) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new StakeModeClient({ timeoutMs, fetch: (async (url: any, init?: RequestInit) => { calls.push({ url: String(url), init: init! }); const reply = replies.shift(); if (!reply) throw new Error("unexpected secret transport failure"); return typeof reply === "function" ? reply() : reply; }) as typeof fetch });
  return { client, calls };
}
test("SDK connects explicitly, authenticates only fixed loopback headers and keeps tokens out of public values", async () => {
  const { client, calls } = mockClient([bootstrap(), Response.json({ snapshot: { profiles: [{ id: "p1" }] } })]);
  await expect(client.listProfiles()).rejects.toBeInstanceOf(StakeModeError); expect(calls).toHaveLength(0);
  expect(await client.connect()).toEqual({ profiles: [{ id: "p1" }] }); expect(await client.listProfiles()).toEqual([{ id: "p1" }]);
  expect(calls.map(call => call.url)).toEqual(["http://127.0.0.1:8080/workspace/api/bootstrap", "http://127.0.0.1:8080/workspace/api/snapshot"]);
  for (const call of calls) { expect(new Headers(call.init.headers).get("x-stakemode-workspace")).toBe("1"); expect(call.init.redirect).toBe("error"); expect(call.url).not.toContain(tokenA); }
  expect(new Headers(calls[0]!.init.headers).get("authorization")).toBeNull(); expect(new Headers(calls[1]!.init.headers).get("authorization")).toBe(`Bearer ${tokenA}`);
  expect(JSON.stringify(client)).not.toContain(tokenA); client.disconnect(); await expect(client.jobs()).rejects.toThrow("connect()");
});
test("SDK refreshes an idempotent GET once and never repeats an unauthorized mutation", async () => {
  const { client, calls } = mockClient([bootstrap(), Response.json({ error: "private-token" }, { status: 401 }), bootstrap(tokenB), Response.json({ jobs: [] }), Response.json({ error: "password-secret" }, { status: 401 })]);
  await client.connect(); expect(await client.jobs()).toEqual({ jobs: [] });
  expect(new Headers(calls[3]!.init.headers).get("authorization")).toBe(`Bearer ${tokenB}`);
  let failure: unknown; try { await client.start("p1"); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(StakeModeError); expect((failure as StakeModeError).status).toBe(401);
  expect(String(failure)).not.toContain("password-secret"); expect(String(failure)).not.toContain(tokenB);
  expect(calls.filter(call => call.init.method === "POST")).toHaveLength(1);
  await expect(client.start("p1")).rejects.toThrow("connect()"); expect(calls).toHaveLength(5);
});
test("SDK rejects redirects and does not expose server response or transport secrets in errors", async () => {
  const { client, calls } = mockClient([bootstrap(), new Response("token-secret", { status: 302, headers: { location: "https://attacker.test/?token=secret" } }), Response.json({ error: "raw cookie=private" }, { status: 400 })]);
  await client.connect();
  for (const path of ["snapshot", "jobs"]) { try { await client.request("GET", path); throw new Error("Expected failure"); } catch (error) { expect(error).toBeInstanceOf(StakeModeError); expect(String(error)).not.toMatch(/attacker|token-secret|cookie=private/); } }
  expect(calls).toHaveLength(3); expect(calls.every(call => call.url.startsWith("http://127.0.0.1:8080/workspace/api/"))).toBe(true);
});
test("SDK rejects remote bases, arbitrary driver routes, traversal and token-bearing query strings before sending", async () => {
  for (const baseUrl of ["https://127.0.0.1:8080", "http://localhost:8080", "http://127.0.0.1:80", "http://127.0.0.1:8080@evil.test", "http://user:secret@127.0.0.1:8080", "http://127.0.0.1:8080/?token=secret", "http://127.0.0.1:8080/path"]) expect(() => new StakeModeClient({ baseUrl })).toThrow("configuration");
  const { client, calls } = mockClient([bootstrap()]); await client.connect();
  for (const path of ["../ui/api/health", "profiles/p1/%2e%2e", "https://evil.test", "/snapshot", "cdp", "firefox-owner", "snapshot?token=private", "profiles/p1/cookies?origin=https%3A%2F%2Fuser%3Asecret%40site.test", "jobs/id/output?format=csv&token=private"])
    await expect(client.request("GET", path)).rejects.toThrow("configuration");
  expect(calls).toHaveLength(1);
});
test("SDK bounds response/body size and deadline without echoing user data", async () => {
  const { client, calls } = mockClient([bootstrap(), new Response("x".repeat(1024 * 1024 + 1))]); await client.connect();
  await expect(client.jobs()).rejects.toThrow("exceeds");
  await expect(client.createProfiles({ notes: "private".repeat(200000) })).rejects.toThrow("configuration"); expect(calls).toHaveLength(2);
  const hanging = mockClient([bootstrap(), () => new Promise<Response>(() => {})], 100); await hanging.client.connect();
  const at = Date.now(); await expect(hanging.client.jobs()).rejects.toThrow("timed out"); expect(Date.now() - at).toBeLessThan(1000); expect(hanging.calls[1]!.init.signal!.aborted).toBe(true);
});
test("SDK convenience methods preserve actual management/workflow routes without writing files", async () => {
  const { client, calls } = mockClient([bootstrap(), ...Array.from({ length: 13 }, () => Response.json({ ok: true }))]); await client.connect();
  await client.createProfiles({ count: 1 }); await client.manual("p1"); await client.browserAction("p1", { action: "new-tab" });
  await client.setMetadata("p1", { tags: ["qa"] }); await client.exportProfiles(["p1"]); await client.importProfiles({ profiles: [] });
  await client.assignExtension("p1", { extensionId: "abc", enabled: false }); await client.assignProxy("p1", { networkMode: "system" });
  await client.setScreen("p1", 1473, 913);
  await client.runWorkflow("wf_123", ["p1"]); await client.cancelJob("job_123"); await client.jobOutput("job_123", "csv"); await client.saveSchedule({ enabled: false });
  expect(calls.slice(1).map(call => call.url.split("/workspace/api/")[1])).toEqual(["bulk", "manual", "profiles/p1/browser", "library/profiles/p1", "library/export?ids=p1", "library/import", "profiles/p1/extensions", "profiles/p1/network", "profiles/p1/screen", "workflows/wf_123/run", "jobs/job_123/cancel", "jobs/job_123/output?format=csv", "schedules"]);
  expect(calls[9]!.init.method).toBe("POST"); expect(JSON.parse(calls[9]!.init.body as string)).toEqual({ width: 1473, height: 913 });
});

test("SDK stops after one failed GET refresh and clears authorization for subsequent writes", async () => {
  const { client, calls } = mockClient([bootstrap(), Response.json({}, { status: 401 }), bootstrap(tokenB), Response.json({}, { status: 401 })]);
  await client.connect(); await expect(client.jobs()).rejects.toThrow("connect()");
  expect(calls).toHaveLength(4); await expect(client.start("p1")).rejects.toThrow("connect()"); expect(calls).toHaveLength(4);
});


test("GameBrowser aliases preserve scripts and profile IDs match the store grammar", async () => {
  expect(GameBrowserClient).toBe(StakeModeClient); expect(GameBrowserError).toBe(StakeModeError);
  const profileId = "A" + "b".repeat(127);
  const { client, calls } = mockClient([bootstrap(), Response.json({ ok: true })]); await client.connect();
  await client.browserState(profileId); expect(calls[1]!.url).toEndWith(`profiles/${profileId}/browser`);
  for (const unsafe of ["A".repeat(129), "_leading", "-leading", "CON", "con", "PrN", "AUX", "NUL", "COM1", "lpt9", "../escape"]) {
    expect(() => client.start(unsafe)).toThrow("configuration");
    await expect(client.request("GET", `profiles/${unsafe}/browser`)).rejects.toThrow("configuration");
  }
  expect(calls).toHaveLength(2);
});
test("following and saved-session helpers retain explicit assignment semantics", async () => {
  const { client, calls } = mockClient([bootstrap(), ...Array.from({ length: 7 }, () => Response.json({ ok: true }))]); await client.connect();
  await client.syncStatus(); await client.follow("admin", ["follower"], true); await client.saveSession();
  await client.resumeSession(); await client.stopFollowing(); await client.proxies(); await client.importProxies({ text: "http://127.0.0.1:9000" });
  expect(calls.slice(1).map(call => call.url.split("/workspace/api/")[1])).toEqual(["sync", "sync", "sync", "sync", "sync", "proxies", "proxies/import"]);
  expect(JSON.parse(calls[2]!.init.body as string)).toEqual({ adminId: "admin", followerIds: ["follower"], saveSession: true });
  expect(calls[5]!.init.method).toBe("DELETE");
});
