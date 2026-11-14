import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelaySessionController } from "./sessionController.ts";
import { SyncRelay, type RelayTransport } from "./syncRelay.ts";

class Transport implements RelayTransport {
  packets: any[] = [];
  send(packet: unknown) { this.packets.push(packet); }
  close() {}
  actions() { return this.packets.filter(packet => packet.type === "ACTION"); }
}
function fixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), "gamebrowser-relay-session-"));
  const profiles = new Set(["firefox-admin", ...Array.from({ length: 32 }, (_, index) => `follower-${index}`)]);
  const running = new Set(profiles), manual: string[] = [];
  const relay = new SyncRelay({ preserveAssignments: true, ackTimeoutMs: 60000 });
  relay.configure(["https://site.test"], "fast");
  for (const id of profiles) relay.register(id, "https://site.test");
  const options = { stateRoot, relay, profileExists: (id: string) => profiles.has(id), hasLaunch: (id: string) => running.has(id),
    setManual: (id: string, enabled: boolean) => { manual.push(`${id}:${enabled}`); } };
  const controller = new RelaySessionController(options);
  const connect = (id: string) => {
    const transport = new Transport();
    expect(relay.authenticate(id, relay.tokenFor(id), transport)).toBe(true);
    relay.receive(id, transport, { type: "PAGE", url: "https://site.test/workspace" });
    return transport;
  };
  const action = (seq: number) => ({ type: "ACTION", id: `event_0000${seq}`, seq, epoch: relay.epoch,
    origin: "https://site.test", url: "https://site.test/workspace", action: "scroll", x: 0, y: seq * 20 });
  const cleanup = () => { relay.stop(); rmSync(stateRoot, { recursive: true, force: true }); };
  return { stateRoot, relay, controller, options, running, profiles, manual, connect, action, cleanup };
}
test("standalone following accepts Firefox Admin and more than twenty followers without owning browser lifetimes", async () => {
  const f = fixture();
  try {
    const state = await f.controller.start("firefox-admin", Array.from(f.profiles).slice(1));
    expect(state.adminId).toBe("firefox-admin"); expect(state.followerIds).toHaveLength(32);
    expect(state.waiting).toBe(true); expect(state.active).toBe(false);
    expect(f.relay.configFor("firefox-admin")?.preserveAssignments).toBe(true);
    const launches = new Set(f.running);
    await f.controller.stop();
    expect(f.running).toEqual(launches); expect(f.controller.status().adminId).toBeNull();
    expect(f.relay.statuses().every(profile => profile.role === "manual")).toBe(true);
  } finally { f.cleanup(); }
});
test("saved sessions load inactive and require explicit Resume; forgetting persists across restart", async () => {
  const f = fixture();
  try {
    await f.controller.start("firefox-admin", ["follower-0"], true);
    const restarted = new RelaySessionController(f.options);
    expect(restarted.status()).toMatchObject({ adminId: null, active: false, saved: true, savedAdminId: "firefox-admin" });
    await restarted.resume();
    expect(restarted.status().adminId).toBe("firefox-admin");
    await restarted.stop();
    expect(restarted.status()).toMatchObject({ adminId: null, saved: true });
    await restarted.save(false);
    expect(new RelaySessionController(f.options).status()).toMatchObject({ adminId: null, saved: false, error: null });
    expect(readFileSync(join(f.stateRoot, "workspace", "following-session.json"), "utf8")).not.toContain("token");
  } finally { f.cleanup(); }
});
test("closing/reconnecting follower retains assignment, discards queued packets and resumes future actions only", async () => {
  const f = fixture();
  try {
    await f.controller.start("firefox-admin", ["follower-0"]);
    const admin = f.connect("firefox-admin"), follower = f.connect("follower-0");
    expect(f.controller.status().active).toBe(true);
    f.relay.receive("firefox-admin", admin, f.action(1));
    f.relay.receive("firefox-admin", admin, f.action(2));
    expect(follower.actions()).toHaveLength(1);
    f.relay.disconnect("follower-0", follower); f.running.delete("follower-0");
    expect(f.controller.status()).toMatchObject({ adminId: "firefox-admin", followerIds: ["follower-0"], active: false, waiting: true });
    expect(f.relay.configFor("follower-0")?.role).toBe("follower");
    f.running.add("follower-0"); const reopened = f.connect("follower-0");
    expect(reopened.actions()).toHaveLength(0); expect(f.controller.status().active).toBe(true);
    f.relay.receive("firefox-admin", admin, f.action(3));
    expect(reopened.actions().map(action => action.seq)).toEqual([3]);
  } finally { f.cleanup(); }
});
test("protective page failure retains roles; explicit popup Manual remains user controlled", async () => {
  const f = fixture();
  try {
    await f.controller.start("firefox-admin", ["follower-0"]);
    const admin = f.connect("firefox-admin"), follower = f.connect("follower-0");
    f.relay.receive("follower-0", follower, { type: "MANUAL_OVERRIDE", reason: "Sensitive interaction", source: "content-script" });
    expect(f.relay.configFor("follower-0")).toMatchObject({ role: "follower", paused: true });
    expect(f.controller.status().followerIds).toEqual(["follower-0"]);
    await f.controller.start("firefox-admin", ["follower-0"]);
    expect(f.controller.status().active).toBe(true);
    f.relay.receive("firefox-admin", admin, { type: "MANUAL_OVERRIDE", source: "extension-popup" });
    expect(f.relay.configFor("firefox-admin")?.role).toBe("manual");
  } finally { f.cleanup(); }
});
test("explicit pause survives transport reconnect and suspension keeps saved session", async () => {
  const f = fixture();
  try {
    await f.controller.configurePolicy({ origins: ["https://site.test"], pacing: "fast", sensitiveControls: "manual", pausedProfileIds: ["follower-0"] });
    await f.controller.start("firefox-admin", ["follower-0"], true);
    f.connect("firefox-admin"); const follower = f.connect("follower-0");
    expect(f.relay.configFor("follower-0")).toMatchObject({ role: "follower", paused: true });
    f.relay.disconnect("follower-0", follower); f.connect("follower-0");
    expect(f.relay.configFor("follower-0")?.paused).toBe(true);
    await f.controller.suspend("Application closing");
    expect(f.controller.status()).toMatchObject({ active: false, saved: true, adminId: "firefox-admin", followerIds: ["follower-0"] });
  } finally { f.cleanup(); }
});
test("standalone bounds invalid plans and preserves the existing session on rejection", async () => {
  const f = fixture();
  try {
    await f.controller.start("firefox-admin", ["follower-0"]);
    for (const ids of [[], ["firefox-admin"], ["follower-0", "follower-0"], ["missing"], Array.from({ length: 256 }, (_, index) => `p${index}`)]) {
      await expect(f.controller.start("firefox-admin", ids)).rejects.toThrow();
      expect(f.controller.status().followerIds).toEqual(["follower-0"]);
    }
  } finally { f.cleanup(); }
});
