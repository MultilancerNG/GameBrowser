import { expect, test } from "bun:test";
import { RelayBrowserFollowing, type FollowedBrowserState } from "./browserFollowing.ts";
import type { BrowserSyncState } from "../browser-sync.ts";
import type { ProfileBrowserState } from "./protocol.ts";
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function state(url = "https://site.test/start", tabs = 1): ProfileBrowserState {
  return { profileId: "admin", activeTabId: "tab_admin000000000000", tabs: Array.from({ length: tabs }, (_, index) => ({ id: `tab_admin00000000000${index}`, title: "Fixture", url: index ? "about:blank" : url, loading: false })), loading: false, canGoBack: null, canGoForward: null, redacted: true };
}
function fixture() {
  let generation = 1;
  const ready = new Set(["admin", "follower"]), stamps = new Map([["admin", 1], ["follower", 1]]);
  const session: BrowserSyncState = { active: true, starting: false, waiting: false, saved: false, adminId: "admin", followerIds: ["follower"], savedAdminId: null, savedFollowerIds: [], failedFollowerIds: [], error: null };
  const applied: Array<{ id: string; key: string; event: FollowedBrowserState }> = [], paused: string[] = [];
  let apply: ((current: () => boolean) => Promise<void>) | undefined;
  const coordinator = new RelayBrowserFollowing({ session: () => session, generation: () => generation, origins: () => ["https://site.test"], pacing: () => "fast", ready: id => ready.has(id), stamp: id => stamps.get(id) ?? -1,
    apply: async (id, key, event, current) => { if (apply) await apply(current); if (current()) applied.push({ id, key, event }); }, pause: id => paused.push(id) });
  return { coordinator, applied, paused, session, ready, stamps, nextGeneration: () => generation++, setApply: (value: typeof apply) => { apply = value; } };
}
test("relay browser observations seed existing pages then forward approved navigation and tab changes for either engine", async () => {
  const f = fixture();
  try {
    f.coordinator.observe(state()); await tick();
    expect(f.applied[0]?.event.baseline).toBe(true);
    f.coordinator.observe(state("https://site.test/second", 2)); await tick();
    expect(f.applied[1]?.event).toMatchObject({ baseline: false, skipNavigation: false });
    expect(f.applied[1]?.event.state.tabs).toHaveLength(2);
    f.coordinator.observe(state("https://site.test/second"), { action: "reload" }); await tick();
    expect(f.applied.at(-1)?.event.reloadTabId).toBe("tab_admin000000000000");
    expect(f.paused).toEqual([]);
  } finally { await f.coordinator.stop(); }
});
test("navigation never shares query strings, credentials, authentication pages or unapproved origins", async () => {
  const f = fixture();
  try {
    for (const url of ["https://site.test/?token=private", "https://user:pass@site.test/", "https://site.test/login", "https://outside.test/", "file:///private"]) f.coordinator.observe(state(url));
    await tick(); expect(f.applied).toHaveLength(0);
  } finally { await f.coordinator.stop(); }
});
test("DOM link actions do not also replay their account-specific destination; explicit URL commands remain mirrored", async () => {
  const f = fixture();
  try {
    f.coordinator.observe(state()); await tick();
    f.coordinator.noteAction("admin", { action: "click" } as any);
    f.coordinator.observe(state("https://site.test/link")); await tick();
    expect(f.applied.at(-1)?.event.skipNavigation).toBe(true);
    f.coordinator.observe(state("https://site.test/address"), { action: "navigate", url: "https://site.test/address" }); await tick();
    expect(f.applied.at(-1)?.event.skipNavigation).toBe(false);
  } finally { await f.coordinator.stop(); }
});
test("pause, reconnect and Stop cancel queued browser actions instead of replaying a backlog", async () => {
  const f = fixture(); let release!: () => void;
  try {
    f.coordinator.observe(state()); await tick(); f.applied.length = 0;
    f.setApply(async () => { await new Promise<void>(resolve => { release = resolve; }); });
    f.coordinator.observe(state("https://site.test/pending")); await tick();
    f.coordinator.observe(state("https://site.test/stale"));
    f.stamps.set("follower", 2); f.coordinator.disconnected("follower"); release(); await tick();
    expect(f.applied).toHaveLength(0);
    f.setApply(undefined); f.coordinator.observe(state("https://site.test/reconnected")); await tick();
    expect(f.applied).toHaveLength(1); expect(f.applied[0]?.event.baseline).toBe(true);
    f.nextGeneration(); f.coordinator.observe(state("https://site.test/resumed")); await tick();
    expect(f.applied.at(-1)?.event.baseline).toBe(true);
  } finally { await f.coordinator.stop(); }
});
