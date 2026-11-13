import { describe, expect, test } from "bun:test";
import { SyncRelay, type RelayTransport } from "./syncRelay.ts";
import type { ActionPacket } from "./eventPolicy.ts";
import { approvedOrigin, safeManualControl, sameToken, trustedLocalRequest } from "./protocol.ts";

class Transport implements RelayTransport {
  packets: any[] = [];
  closed = false;
  send(packet: unknown) { this.packets.push(packet); }
  close() { this.closed = true; }
  actions(): ActionPacket[] { return this.packets.filter(p => p.type === "ACTION"); }
}
function fixture(pacing: "fast" | "paced" = "fast") {
  const relay = new SyncRelay({ random: () => 0, ackTimeoutMs: 60_000 });
  relay.configure(["https://site.test", "https://other.test"], pacing);
  const a = relay.register("admin", "https://site.test"), b = relay.register("follower", "https://site.test");
  relay.setRole("admin", "admin"); relay.setRole("follower", "follower");
  const admin = new Transport(), follower = new Transport();
  relay.authenticate("admin", a.token, admin); relay.authenticate("follower", b.token, follower);
  for (const [id, transport] of [["admin", admin], ["follower", follower]] as const) relay.receive(id, transport, { type: "PAGE", url: "https://site.test/dashboard" });
  const action = (seq: number): ActionPacket => ({ type: "ACTION", id: `event_0000${seq}`, seq, epoch: relay.epoch, origin: "https://site.test", url: "https://site.test/dashboard", action: "scroll", x: 0, y: seq * 10 });
  return { relay, admin, follower, action };
}
describe("authenticated synchronization relay", () => {
  test("authenticates profile-scoped tokens without leaking them in configuration", () => {
    const { relay } = fixture(); const attacker = new Transport();
    expect(relay.authenticate("follower", "bad", attacker)).toBe(false);
    const config = relay.configFor("follower")!;
    expect(config.token).toHaveLength(43);
    expect(relay.authenticate("admin", config.token, attacker)).toBe(false);
    relay.stop();
  });
  test("preserves FIFO ordering and requires acknowledgement before the next action", () => {
    const { relay, admin, follower, action } = fixture();
    relay.receive("admin", admin, action(1)); relay.receive("admin", admin, action(2));
    expect(follower.actions().map(a => a.seq)).toEqual([1]);
    relay.receive("follower", follower, { type: "ACK", epoch: relay.configFor("follower")!.epoch, id: "event_00001", status: "applied" });
    expect(follower.actions().map(a => a.seq)).toEqual([1, 2]);
    relay.receive("follower", follower, { type: "ACK", epoch: relay.configFor("follower")!.epoch, id: "event_00002", status: "applied" });
    relay.receive("admin", admin, action(2));
    expect(follower.actions()).toHaveLength(2);
    relay.stop();
  });
  test("rejects financial and credential targets before dispatch", () => {
    const { relay, admin, follower, action } = fixture();
    for (const label of ["place bet", "currentPassword", "verification code", "withdraw"]) relay.receive("admin", admin, { ...action(1), action: "click", selector: '[name="operation"]', x: undefined, y: undefined, fingerprint: { tag: "button", text: label } });
    expect(follower.actions()).toHaveLength(0);
    relay.stop();
  });
  test("manual override cancels delayed packets and advances the epoch", async () => {
    const { relay, admin, follower, action } = fixture("paced");
    const before = relay.configFor("follower")!.epoch;
    relay.receive("admin", admin, action(1));
    relay.receive("follower", follower, { type: "MANUAL_OVERRIDE", enabled: true });
    expect(relay.configFor("follower")!.epoch).toBeGreaterThan(before);
    await new Promise(resolve => setTimeout(resolve, 475));
    expect(follower.actions()).toHaveLength(0);
    expect(relay.statuses().find(p => p.profileId === "follower")!.role).toBe("manual");
    relay.stop();
  });
  test("disconnect and negative acknowledgement cannot replay pending actions", () => {
    const { relay, admin, follower, action } = fixture();
    relay.receive("admin", admin, action(1)); relay.receive("admin", admin, action(2));
    relay.receive("follower", follower, { type: "ACK", epoch: relay.configFor("follower")!.epoch, id: "event_00001", status: "rejected" });
    expect(follower.actions()).toHaveLength(1);
    expect(relay.statuses().find(p => p.profileId === "follower")!.queued).toBe(0);
    relay.disconnect("admin", admin);
    expect(relay.statuses().find(p => p.profileId === "admin")!.role).toBe("manual");
    relay.stop();
  });
  test("bounds an unacknowledged follower queue and gives it manual control", () => {
    const { relay, admin, follower, action } = fixture();
    for (let seq = 1; seq <= 65; seq++) relay.receive("admin", admin, action(seq));
    const status = relay.statuses().find(p => p.profileId === "follower")!;
    expect(status.role).toBe("manual"); expect(status.queued).toBe(0);
    expect(follower.actions()).toHaveLength(1);
    relay.stop();
  });
  test("refuses events from a follower or a mismatched origin", () => {
    const { relay, admin, follower, action } = fixture();
    relay.receive("follower", follower, action(1));
    relay.receive("admin", admin, { ...action(1), origin: "https://other.test", url: "https://other.test/dashboard" });
    expect(follower.actions()).toHaveLength(0);
    relay.stop();
  });
});
test("local API credentials require same-origin custom-header requests", () => {
  const req = (headers: Record<string, string>) => new Request("http://127.0.0.1:8080/workspace/api/bootstrap", { headers });
  expect(trustedLocalRequest(req({ "x-stakemode-workspace": "1", origin: "http://127.0.0.1:8080", host: "127.0.0.1:8080" }), "127.0.0.1")).toBe(true);
  expect(trustedLocalRequest(req({ "x-stakemode-workspace": "1", origin: "https://attacker.test" }), "127.0.0.1")).toBe(false);
  expect(trustedLocalRequest(req({ "x-stakemode-workspace": "1", "sec-fetch-site": "cross-site" }), "127.0.0.1")).toBe(false);
  expect(trustedLocalRequest(req({}), "127.0.0.1")).toBe(false);
  expect(trustedLocalRequest(req({ "x-stakemode-workspace": "1" }), "192.168.1.1")).toBe(false);
});
test("origin and manual input validation forbid credentials and unbounded commands", () => {
  expect(approvedOrigin("http://127.0.0.1:4567")).toBe("http://127.0.0.1:4567");
  expect(() => approvedOrigin("http://stake.com")).toThrow();
  expect(() => approvedOrigin("https://user:pass@stake.com")).toThrow();
  expect(() => safeManualControl({ profileId: "p", kind: "key", key: "Control+Shift+J" })).toThrow();
  expect(() => safeManualControl({ profileId: "p", kind: "text", text: "x".repeat(4097) })).toThrow();
});

test("token comparison rejects same-character-length Unicode without throwing", () => {
  expect(sameToken("é".repeat(43), "a".repeat(43))).toBe(false);
  expect(sameToken("a".repeat(43), "a".repeat(43))).toBe(true);
  expect(sameToken("a".repeat(42), "a".repeat(43))).toBe(false);
});
test("manual decoupling cancels one paced follower while another retains its queue and epoch", async () => {
  const { relay, admin, follower, action } = fixture("paced");
  const second = relay.register("second", "https://site.test"), other = new Transport();
  relay.setRole("second", "follower"); relay.authenticate("second", second.token, other);
  relay.receive("second", other, { type: "PAGE", url: "https://site.test/dashboard" });
  const adminEpoch = relay.configFor("admin")!.epoch, otherEpoch = relay.configFor("second")!.epoch;
  relay.receive("admin", admin, action(1)); relay.receive("admin", admin, action(2));
  relay.receive("follower", follower, { type: "MANUAL_OVERRIDE", enabled: true });
  expect(relay.configFor("admin")!.epoch).toBe(adminEpoch);
  expect(relay.configFor("second")!.epoch).toBe(otherEpoch);
  expect(relay.statuses().find(p => p.profileId === "second")!.queued).toBe(2);
  await new Promise(resolve => setTimeout(resolve, 475));
  expect(follower.actions()).toHaveLength(0);
  expect(other.actions().map(p => p.seq)).toEqual([1]);
  expect(other.actions()[0]!.epoch).toBe(otherEpoch);
  relay.receive("second", other, { type: "ACK", id: other.actions()[0]!.id, epoch: otherEpoch, status: "applied" });
  await new Promise(resolve => setTimeout(resolve, 475));
  expect(other.actions().map(p => p.seq)).toEqual([1, 2]);
  relay.stop();
});
test("pause and disconnect are scoped to their follower and stale ACK cannot advance resumed queues", () => {
  const { relay, admin, follower, action } = fixture();
  const second = relay.register("second", "https://site.test"), other = new Transport();
  relay.setRole("second", "follower"); relay.authenticate("second", second.token, other);
  relay.receive("second", other, { type: "PAGE", url: "https://site.test/dashboard" });
  const otherEpoch = relay.configFor("second")!.epoch;
  relay.receive("admin", admin, action(1)); relay.receive("admin", admin, action(2));
  const oldEpoch = relay.configFor("follower")!.epoch;
  relay.setPaused("follower", true);
  expect(relay.configFor("second")!.epoch).toBe(otherEpoch);
  expect(relay.statuses().find(p => p.profileId === "second")!.queued).toBe(2);
  relay.setPaused("follower", false);
  // Reuse an identifier in a later generation: an old acknowledgement must
  // still be incapable of releasing the new generation's next action.
  relay.receive("admin", admin, { ...action(3), id: "event_00001" }); relay.receive("admin", admin, action(4));
  const before = follower.actions().length;
  relay.receive("follower", follower, { type: "ACK", id: "event_00001", epoch: oldEpoch, status: "applied" });
  expect(follower.actions()).toHaveLength(before);
  relay.receive("follower", follower, { type: "ACK", id: "event_00001", epoch: relay.configFor("follower")!.epoch, status: "applied" });
  expect(follower.actions()).toHaveLength(before + 1);
  relay.disconnect("follower", follower);
  expect(relay.configFor("second")!.epoch).toBe(otherEpoch);
  expect(relay.statuses().find(p => p.profileId === "second")!.queued).toBe(4);
  relay.stop();
});
test("administrator takeover cancels the group including already queued followers", () => {
  const { relay, admin, follower, action } = fixture();
  relay.receive("admin", admin, action(1)); relay.receive("admin", admin, action(2));
  const before = relay.configFor("follower")!.epoch;
  relay.manual("admin", "operator_manual");
  expect(relay.configFor("follower")!.epoch).toBeGreaterThan(before);
  expect(relay.statuses().find(p => p.profileId === "follower")!.queued).toBe(0);
  relay.stop();
});

test("deleting a follower revokes its token and cancels only its queued work", async () => {
  const { relay, admin, follower, action } = fixture("paced");
  const deletedToken = relay.tokenFor("follower")!;
  const second = relay.register("survivor", "https://site.test"), survivor = new Transport();
  relay.setRole("survivor", "follower"); relay.authenticate("survivor", second.token, survivor);
  relay.receive("survivor", survivor, { type: "PAGE", url: "https://site.test/dashboard" });
  const epoch = relay.configFor("survivor")!.epoch;
  relay.receive("admin", admin, action(1));
  relay.unregister("follower");
  expect(follower.closed).toBe(true);
  expect(relay.configFor("follower")).toBeUndefined();
  expect(relay.authenticate("follower", deletedToken, new Transport())).toBe(false);
  expect(relay.configFor("survivor")!.epoch).toBe(epoch);
  await new Promise(resolve => setTimeout(resolve, 475));
  expect(follower.actions()).toHaveLength(0);
  expect(survivor.actions()).toHaveLength(1);
  const recreated = relay.register("follower", "https://site.test");
  expect(recreated.token).not.toBe(deletedToken);
  expect(relay.authenticate("follower", deletedToken, new Transport())).toBe(false);
  relay.stop();
});

test("deleting an administrator invalidates pending group work", () => {
  const { relay, admin, follower, action } = fixture();
  relay.receive("admin", admin, action(1)); relay.receive("admin", admin, action(2));
  const epoch = relay.configFor("follower")!.epoch;
  relay.unregister("admin");
  expect(admin.closed).toBe(true);
  expect(relay.configFor("follower")!.epoch).toBeGreaterThan(epoch);
  expect(relay.statuses().find(row => row.profileId === "follower")!.queued).toBe(0);
  relay.receive("follower", follower, { type: "ACK", id: "event_00001", epoch, status: "applied" });
  expect(follower.actions()).toHaveLength(1);
  relay.stop();
});

test("worker controller retains explicit group through follower interaction and reconnect without a second mirror", () => {
  const relay = new SyncRelay({ controller: "worker" });
  relay.setRelayUrl("ws://127.0.0.1:50773/workspace/relay");
  const adminConfig = relay.register("admin"), followerConfig = relay.register("follower");
  relay.setGroup("admin", ["follower"]);
  const admin = new Transport(), follower = new Transport();
  expect(relay.authenticate("admin", adminConfig.token, admin)).toBe(true);
  expect(relay.authenticate("follower", followerConfig.token, follower)).toBe(true);
  expect(relay.configFor("admin")?.relayUrl).toBe("ws://127.0.0.1:50773/workspace/relay");
  expect(admin.packets.at(-1).controller).toBe("worker");
  relay.receive("follower", follower, { type: "MANUAL_OVERRIDE", enabled: true });
  relay.receive("follower", follower, { type: "PAGE", url: "https://another.test/account?token=own" });
  expect(relay.configFor("follower")?.role).toBe("follower");
  relay.receive("admin", admin, { type: "ACTION", id: "action001", origin: "https://another.test", action: "click" });
  expect(follower.actions()).toEqual([]);
  relay.disconnect("follower", follower);
  expect(relay.configFor("follower")?.role).toBe("follower");
  expect(relay.configFor("admin")?.role).toBe("admin");
  const reopened = new Transport();
  expect(relay.authenticate("follower", followerConfig.token, reopened)).toBe(true);
  expect(reopened.actions()).toEqual([]);
  expect(relay.statuses().find(row => row.profileId === "follower")?.paused).toBe(false);
  relay.setGroup(null, []);
  expect(relay.configFor("admin")?.role).toBe("manual");
  expect(relay.configFor("follower")?.role).toBe("manual");
  relay.stop();
});

test("late authorization loss prevents a paced relay action without erasing assignment", async () => {
  let authorized = true;
  const relay = new SyncRelay({ isAuthorized: () => authorized, random: () => 0 });
  relay.configure(["https://site.test"], "paced");
  const a = relay.register("admin", "https://site.test"), f = relay.register("follower", "https://site.test");
  relay.setGroup("admin", ["follower"]);
  const admin = new Transport(), follower = new Transport();
  relay.authenticate("admin", a.token, admin); relay.authenticate("follower", f.token, follower);
  for (const [id, transport] of [["admin", admin], ["follower", follower]] as const) relay.receive(id, transport, { type: "PAGE", url: "https://site.test/page" });
  relay.receive("admin", admin, { type: "ACTION", id: "event001", seq: 1, epoch: relay.epoch, origin: "https://site.test", url: "https://site.test/page", action: "scroll", x: 0, y: 10 });
  authorized = false;
  await new Promise(resolve => setTimeout(resolve, 480));
  expect(follower.actions()).toEqual([]);
  expect(relay.configFor("follower")?.role).toBe("follower");
  expect(relay.statuses().find(row => row.profileId === "follower")?.paused).toBe(true);
  relay.stop();
});

test("explicit operator pause survives worker transport reconnect without changing its follower role", () => {
  const relay = new SyncRelay({ controller: "worker" });
  relay.register("admin"); const config = relay.register("follower"); relay.setGroup("admin", ["follower"]);
  const transport = new Transport(); relay.authenticate("follower", config.token, transport); relay.setPaused("follower", true);
  relay.disconnect("follower", transport); const reopened = new Transport(); relay.authenticate("follower", config.token, reopened);
  expect(relay.explicitlyPausedProfileIds()).toEqual(["follower"]);
  expect(relay.statuses().find(row => row.profileId === "follower")?.paused).toBe(true);
  expect(relay.configFor("follower")?.role).toBe("follower");
  relay.setPaused("follower", false); expect(relay.explicitlyPausedProfileIds()).toEqual([]); relay.stop();
});

test("relay registration uses central128-character safe profile IDs", () => {
  const relay = new SyncRelay({ controller: "worker" });
  const profileId = "id-" + "x".repeat(125); expect(relay.register(profileId).profileId).toBe(profileId);
  for (const id of ["CON", "nul", "_invalid", "../escape", "x".repeat(129)]) expect(() => relay.register(id)).toThrow();
  relay.stop();
});
