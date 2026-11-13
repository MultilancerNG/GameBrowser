import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore } from "./store.ts";

test("saved mirroring plans retain only validated role IDs across database reopen and account scopes", () => {
  const root = mkdtempSync(join(tmpdir(), "gamebrowser-sync-plan-"));
  let store = new ProfileStore(join(root, "profiles.sqlite"));
  try {
    store.setBrowserSyncPlan("local", { adminId: "admin", followerIds: ["first", "second"] });
    store.close();
    store = new ProfileStore(join(root, "profiles.sqlite"));
    expect(store.getBrowserSyncPlan("local")).toEqual({ adminId: "admin", followerIds: ["first", "second"] });
    expect(store.getBrowserSyncPlan("cloud:another-account")).toBeNull();
    expect(() => store.setBrowserSyncPlan("local", { adminId: "../bad", followerIds: ["follower"] })).toThrow();
    expect(() => store.setBrowserSyncPlan("local", { adminId: "admin", followerIds: ["admin"] })).toThrow();
    expect(() => store.setBrowserSyncPlan("local", { adminId: "admin", followerIds: ["ws://outside"] })).toThrow();
    expect(() => store.setBrowserSyncPlan("local", { adminId: "admin", followerIds: ["same", "same"] })).toThrow();
    store.setBrowserSyncPlan("local", null);
    expect(store.getBrowserSyncPlan("local")).toBeNull();
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
