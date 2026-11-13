import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { BrowserSyncError, BrowserSyncRuntime, browserSyncSelection, type BrowserSyncChild, type BrowserSyncPlan, type BrowserSyncTarget } from "./browser-sync.ts";

class FakeChild extends EventEmitter implements BrowserSyncChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly input: any[] = [];
  exited = false;
  kills = 0;
  readonly stdin: Writable;
  constructor(private readonly settings: { ready?: boolean; stop?: boolean; kill?: boolean } = {}) {
    super();
    this.stdin = new Writable({ write: (chunk, _encoding, callback) => {
      for (const line of chunk.toString().trim().split("\n")) {
        const message = JSON.parse(line);
        this.input.push(message);
        if (message.type === "start" && settings.ready !== false) queueMicrotask(() => this.message({ type: "ready" }));
        if (message.type === "stop" && settings.stop !== false) queueMicrotask(() => this.exit());
      }
      callback();
    } });
  }
  message(value: unknown) { this.stdout.write(`${JSON.stringify(value)}\n`); }
  exit() { if (!this.exited) { this.exited = true; this.emit("exit", 0); } }
  kill() { this.kills++; if (this.settings.kill !== false) this.exit(); return this.settings.kill !== false; }
}

function harness(settings: { ready?: boolean; stop?: boolean; kill?: boolean } = {}, stored?: Map<string, BrowserSyncPlan>) {
  let scope: string | undefined = "local";
  let owned = true;
  let permission = true;
  let available = true;
  let launchVersion = 1;
  const saved = stored ?? new Map<string, BrowserSyncPlan>();
  const children: FakeChild[] = [];
  const resolved: readonly string[][] = [];
  const runtime = new BrowserSyncRuntime({
    scope: () => scope,
    current: (targets) => owned && targets.every((target) => target.generation === `private-ownership-${launchVersion}-${target.id}`),
    authorizePlan: async () => { if (!permission) throw new BrowserSyncError("Profile edit access is required", 403); },
    loadSaved: (key) => saved.get(key) ?? null,
    savePlan: (key, plan) => { if (plan) saved.set(key, structuredClone(plan)); else saved.delete(key); },
    resolveTargets: async (ids) => {
      (resolved as string[][]).push([...ids]);
      if (!available) throw new BrowserSyncError("Waiting for profiles", 409, "browser-unavailable");
      return ids.map((id): BrowserSyncTarget => ({ id, engine: "chromium", endpoint: `ws://127.0.0.1:9000/private/${id}`, generation: `private-ownership-${launchVersion}-${id}` }));
    },
    authorize: async () => { if (!permission) throw new Error("private server detail must not be exposed"); },
    spawnChild: () => { const child = new FakeChild(settings); children.push(child); return child; },
    startupTimeoutMs: 50,
    stopTimeoutMs: 5,
    guardIntervalMs: 5,
    authorizationIntervalMs: 5,
    retryIntervalMs: 10,
  });
  return { runtime, children, resolved, setScope: (value: string | undefined) => { scope = value; }, setOwned: (value: boolean) => { owned = value; }, setPermission: (value: boolean) => { permission = value; }, saved, setAvailable: (value: boolean) => { available = value; }, reopen: () => { available = true; owned = true; launchVersion++; } };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("mirroring resolves only profile IDs and does not expose browser endpoints or ownership", async () => {
  const h = harness();
  try {
    expect(await h.runtime.start("admin", ["follower"])).toEqual({ active: true, starting: false, waiting: false, saved: false, adminId: "admin", followerIds: ["follower"], savedAdminId: null, savedFollowerIds: [], failedFollowerIds: [], error: null });
    expect(h.resolved).toEqual([["admin", "follower"]]);
    expect(h.children[0]!.input[0]).toEqual({
      type: "start", admin: { id: "admin", engine: "chromium", endpoint: "ws://127.0.0.1:9000/private/admin" },
      followers: [{ id: "follower", engine: "chromium", endpoint: "ws://127.0.0.1:9000/private/follower" }], alignOnStart: true,
    });
    expect(JSON.stringify(h.runtime.status())).not.toContain("private");
    expect(JSON.stringify(h.children[0]!.input)).not.toContain("ownership");
  } finally { await h.runtime.stop(); }
  expect(h.children[0]!.input.at(-1)).toEqual({ type: "stop" });
  expect(h.children[0]!.kills).toBe(0);
});

test("invalid selections cannot configure the worker", () => {
  for (const [admin, followers] of [["../escape", ["valid"]], ["admin", []], ["admin", ["admin"]], ["admin", ["same", "same"]], ["admin", ["http://outside.test"]], ["admin", Array.from({ length: 21 }, (_, i) => `f${i}`)]]) {
    expect(() => browserSyncSelection(admin, followers)).toThrow(BrowserSyncError);
  }
});

test("dispatch policy changes keep roles, discard the previous queue and never align an old URL", async () => {
  const h = harness();
  const policy = { origins: ["https://example.test"], pacing: "paced" as const, sensitiveControls: "manual" as const, pausedProfileIds: ["follower"] };
  try {
    await h.runtime.start("admin", ["follower"], true);
    const first = h.children[0]!;
    await h.runtime.configurePolicy(policy);
    expect(first.exited).toBe(true);
    expect(h.runtime.status()).toMatchObject({ active: true, adminId: "admin", followerIds: ["follower"], saved: true });
    expect(h.children[1]!.input[0]).toMatchObject({ alignOnStart: false, policy });
    h.setScope("different-account"); h.runtime.status();
    await h.runtime.start("next-admin", ["next-follower"]);
    expect(h.children.at(-1)!.input[0]).not.toHaveProperty("policy");
  } finally { await h.runtime.stop(); }
});

test("suspending access during startup retains roles and late readiness cannot reactivate the worker", async () => {
  const h = harness({ ready: false });
  const start = h.runtime.start("admin", ["follower"], true).catch(() => undefined);
  await tick();
  const suspend = h.runtime.suspend("Cloud access is unavailable");
  h.children[0]!.message({ type: "ready" });
  await start; await suspend;
  expect(h.runtime.status()).toMatchObject({ active: false, adminId: "admin", followerIds: ["follower"], saved: true, error: "Cloud access is unavailable" });
  expect(h.children).toHaveLength(1);
  await h.runtime.stop();
});

test("a queued save cannot clear the next account's saved plan", async () => {
  const h = harness({ ready: false });
  h.saved.set("other-account", { adminId: "other-admin", followerIds: ["other-follower"] });
  const starting = h.runtime.start("admin", ["follower"], true).catch(() => undefined);
  await tick();
  const save = h.runtime.save(false).catch(error => error);
  h.setScope("other-account"); h.runtime.status();
  await starting;
  expect(await save).toBeInstanceOf(BrowserSyncError);
  expect(h.saved.get("other-account")).toEqual({ adminId: "other-admin", followerIds: ["other-follower"] });
  await h.runtime.stop();
});

test("a changed Admin stops the old helper before connecting the new selection", async () => {
  const h = harness();
  try {
    await h.runtime.start("first", ["second"]);
    const old = h.children[0]!;
    const state = await h.runtime.start("second", ["first"]);
    expect(old.exited).toBe(true);
    expect(state.adminId).toBe("second");
    expect(h.children).toHaveLength(2);
  } finally { await h.runtime.stop(); }
});

test("a newer start cancels a pending connection and late readiness cannot revive it", async () => {
  const h = harness({ ready: false });
  const first = h.runtime.start("first", ["second"]).catch((error) => error);
  await tick();
  const second = h.runtime.start("second", ["third"]);
  await tick();
  expect(h.children[0]!.exited).toBe(true);
  h.children[1]!.message({ type: "ready" });
  expect((await first).status).toBe(409);
  expect((await second).adminId).toBe("second");
  await h.runtime.stop();
});

test("stopping during startup cancels the connection and returns no selected account data", async () => {
  const h = harness({ ready: false });
  const start = h.runtime.start("admin", ["follower"]).catch((error) => error);
  await tick();
  const stop = h.runtime.stop();
  expect(h.runtime.status().adminId).toBeNull();
  expect((await start).status).toBe(409);
  expect((await stop).active).toBe(false);
  expect(h.children[0]!.exited).toBe(true);
});

test("changing account or launch ownership stops mirroring rather than following a new session", async () => {
  for (const change of ["scope", "ownership"] as const) {
    const h = harness();
    await h.runtime.start("admin", ["follower"]);
    if (change === "scope") h.setScope("another-account"); else h.setOwned(false);
    const state = h.runtime.status();
    expect(state.active).toBe(false);
    expect(state.adminId).toBe(change === "scope" ? null : "admin");
    expect(state.followerIds).toEqual(change === "scope" ? [] : ["follower"]);
    expect(state.waiting).toBe(change === "ownership");
    await tick();
    expect(h.children[0]!.exited).toBe(true);
    await h.runtime.stop();
  }
});

test("permission loss is rechecked and stops the automation helper", async () => {
  const h = harness();
  await h.runtime.start("admin", ["follower"]);
  h.setPermission(false);
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(h.runtime.status().active).toBe(false);
  expect(h.runtime.status().error).toContain("edit access");
  expect(JSON.stringify(h.runtime.status())).not.toContain("private server detail");
  expect(h.children[0]!.exited).toBe(true);
  await h.runtime.stop();
});

test("worker errors are isolated and do not disclose page data", async () => {
  const h = harness();
  await h.runtime.start("admin", ["first", "second"]);
  h.children[0]!.message({ type: "follower-error", profileId: "first" });
  expect(h.runtime.status().active).toBe(false);
  expect(h.runtime.status().waiting).toBe(false);
  expect(h.runtime.status().failedFollowerIds).toEqual(["first"]);
  h.children[0]!.message({ type: "failure", message: "password=private-value; ws://private-endpoint" });
  expect(h.runtime.status().active).toBe(false);
  expect(JSON.stringify(h.runtime.status())).not.toContain("private-value");
  await h.runtime.stop();
});

test("a broken worker input pipe stops mirroring without an unhandled EPIPE", async () => {
  const h = harness();
  await h.runtime.start("admin", ["follower"]);
  h.children[0]!.stdin.emit("error", new Error("EPIPE private process detail"));
  expect(h.runtime.status().active).toBe(false);
  expect(JSON.stringify(h.runtime.status())).not.toContain("private process detail");
  await h.runtime.stop();
});

test("startup has a bounded timeout and a stuck helper is killed without browser operations", async () => {
  const h = harness({ ready: false, stop: false });
  await expect(h.runtime.start("admin", ["follower"])).rejects.toMatchObject({ status: 504 });
  expect(h.children[0]!.kills).toBe(1);
  expect(h.runtime.status().active).toBe(false);
  await h.runtime.stop();
});

test("an unconfirmed helper shutdown prevents a replacement from taking control", async () => {
  const h = harness({ stop: false, kill: false });
  await h.runtime.start("admin", ["follower"]);
  await expect(h.runtime.start("second", ["third"])).rejects.toMatchObject({ status: 503 });
  expect(h.children).toHaveLength(1);
  expect(h.runtime.status().error).toContain("could not be stopped");
  // Prove exit so the retained helper can be cleaned up at test end.
  h.children[0]!.exit();
});

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Mirroring state did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a saved group is dormant after app restart and explicit Stop retains it for Resume", async () => {
  const h = harness();
  await h.runtime.start("admin", ["follower"], true);
  expect(h.runtime.status().saved).toBe(true);
  await h.runtime.stop();
  expect(h.runtime.status()).toMatchObject({ active: false, waiting: false, adminId: null, saved: true, savedAdminId: "admin", savedFollowerIds: ["follower"] });
  const fresh = harness({}, h.saved);
  expect(fresh.runtime.status()).toMatchObject({ active: false, waiting: false, adminId: null, saved: true, savedAdminId: "admin" });
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(fresh.children).toHaveLength(0);
  expect((await fresh.runtime.resume()).active).toBe(true);
  expect(fresh.children).toHaveLength(1);
  await fresh.runtime.stop();
});

test("saving and forgetting a configured session does not change roles or disconnect the helper", async () => {
  const h = harness();
  await h.runtime.start("admin", ["follower"]);
  const child = h.children[0]!;
  expect((await h.runtime.save(true)).saved).toBe(true);
  expect(child.exited).toBe(false);
  expect(child.input).toHaveLength(1);
  expect(h.saved.get("local")).toEqual({ adminId: "admin", followerIds: ["follower"] });
  expect((await h.runtime.save(false)).saved).toBe(false);
  expect(child.exited).toBe(false);
  expect(h.runtime.status().adminId).toBe("admin");
  expect(h.children).toHaveLength(1);
  await h.runtime.stop();
  await expect(h.runtime.save(true)).rejects.toMatchObject({ status: 400 });
});

test("closed profiles retain a Waiting group and reconnect to fresh owned launches without replay", async () => {
  const h = harness();
  h.setAvailable(false);
  const waiting = await h.runtime.start("admin", ["follower"], true);
  expect(waiting).toMatchObject({ active: false, waiting: true, saved: true, adminId: "admin", followerIds: ["follower"] });
  expect(h.children).toHaveLength(0);
  h.reopen();
  await until(() => h.runtime.status().active);
  expect(h.runtime.status().adminId).toBe("admin");
  expect(h.children[0]!.input[0].alignOnStart).toBe(false);
  expect(h.children[0]!.input).toHaveLength(1);
  await h.runtime.stop();
});

test("a known follower disconnect replaces only the helper while desired roles remain fixed", async () => {
  const h = harness();
  await h.runtime.start("admin", ["follower"], true);
  const old = h.children[0]!;
  h.setAvailable(false);
  old.message({ type: "follower-error", profileId: "follower", reason: "follower-disconnected" });
  expect(h.runtime.status()).toMatchObject({ active: false, waiting: true, adminId: "admin", followerIds: ["follower"] });
  h.reopen();
  await until(() => h.runtime.status().active);
  expect(old.exited).toBe(true);
  expect(h.children).toHaveLength(2);
  expect(h.children[1]!.input[0].alignOnStart).toBe(false);
  expect(h.children[1]!.input).toHaveLength(1);
  await h.runtime.stop();
});

test("uncertain follower actions require explicit attention and never automatically replay", async () => {
  const h = harness();
  await h.runtime.start("admin", ["follower"], true);
  h.children[0]!.message({ type: "follower-error", profileId: "follower", reason: "action-failed" });
  expect(h.runtime.status()).toMatchObject({ active: false, waiting: false, saved: true, adminId: "admin", failedFollowerIds: ["follower"] });
  expect(h.runtime.status().error).not.toBeNull();
  h.reopen();
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(h.children).toHaveLength(1);
  expect((await h.runtime.resume()).active).toBe(true);
  expect(h.children[1]!.input[0].alignOnStart).toBe(true);
  await h.runtime.stop();
});

test("permission or account changes suspend automatic reconnect until explicit authorization", async () => {
  const h = harness();
  h.setAvailable(false);
  await h.runtime.start("admin", ["follower"], true);
  h.setPermission(false);
  await until(() => !!h.runtime.status().error);
  expect(h.runtime.status().waiting).toBe(false);
  h.setPermission(true);
  h.reopen();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(h.children).toHaveLength(0);
  await h.runtime.resume();
  h.setScope("account-two");
  expect(h.runtime.status()).toMatchObject({ active: false, adminId: null, saved: false, savedAdminId: null });
  h.setScope("local");
  expect(h.runtime.status()).toMatchObject({ active: false, adminId: null, saved: true, savedAdminId: "admin" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(h.children).toHaveLength(1);
  await h.runtime.resume();
  expect(h.children).toHaveLength(2);
  await h.runtime.stop();
});
