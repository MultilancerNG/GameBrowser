import { expect, test } from "bun:test";
import { moveProfile, orderedProfileIds, selectionRanks } from "./profile-order.ts";

test("the last selected profile leads without reserving a profile named Admin", () => {
  const selected = new Set(["admin", "work", "personal"]);
  expect([...selectionRanks(selected)]).toEqual([["personal", 0], ["work", 1], ["admin", 2]]);
  selected.delete("personal");
  expect([...selectionRanks(selected).keys()][0]).toBe("work");
});

test("moving a profile retains hidden and off-page profiles, without duplicating IDs", () => {
  expect(moveProfile(["a", "hidden", "b", "offpage"], "b", "a")).toEqual(["b", "a", "hidden", "offpage"]);
  expect(moveProfile(["a", "b", "c"], "a", "c", true)).toEqual(["b", "c", "a"]);
  expect(moveProfile(["a", "b"], "a", "a")).toEqual(["a", "b"]);
  expect(moveProfile(["a", "b"], "missing", "a")).toEqual(["a", "b"]);
});

test("saved ordering survives roster polling, removed profiles and new profiles", () => {
  const profiles = [{ id: "b", name: "Work" }, { id: "a", name: "Admin" }, { id: "new", name: "New" }];
  expect(orderedProfileIds(profiles, ["deleted", "a", "b", "a"])).toEqual(["a", "b", "new"]);
});

test("manual order survives closing and reopening the application's database", async () => {
  const { ProfileStore } = await import("../store.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "gamebrowser-order-"));
  let store = new ProfileStore(join(root, "profiles.sqlite"));
  try {
    store.setProfileOrder("local", ["work", "personal"]);
    store.close();
    store = new ProfileStore(join(root, "profiles.sqlite"));
    expect(store.getProfileOrder("local")).toEqual(["work", "personal"]);
    expect(store.getProfileOrder("cloud:other-account")).toEqual([]);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
