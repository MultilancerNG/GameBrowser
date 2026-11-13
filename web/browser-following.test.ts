import { expect, test } from "bun:test";
import { EMPTY_BROWSER_SYNC, followingSelection, sameFollowingSelection } from "./browser-following.ts";

const profiles = [
  { id: "first", engine: "chromium" as const, running: true, permission: "edit" as const },
  { id: "second", engine: "chromium" as const, running: true, permission: "edit" as const },
  { id: "firefox", engine: "firefox" as const, running: true, permission: "edit" as const },
];

test("most recently selected Chromium profile controls the other selected profiles", () => {
  expect(followingSelection(profiles, new Set(["firefox", "second", "first"]), true))
    .toEqual({ adminId: "first", followerIds: ["second", "firefox"], issue: null });
  expect(followingSelection(profiles, new Set(["first", "second"]), false).adminId).toBe("second");
});

test("following cannot start with missing, closed, locked, read-only, or unsupported Admin profiles", () => {
  expect(followingSelection(profiles, new Set(["first"]), false).issue).toContain("at least one");
  expect(followingSelection(profiles, new Set(["first", "missing"]), false).issue).toContain("Open every");
  expect(followingSelection([{ ...profiles[0]!, running: false }, profiles[1]!], new Set(["first", "second"]), false).issue).toContain("Open every");
  expect(followingSelection([{ ...profiles[0]!, lockedBy: "other-device" }, profiles[1]!], new Set(["first", "second"]), false).issue).toContain("Open every");
  expect(followingSelection([{ ...profiles[0]!, permission: "view" }, profiles[1]!], new Set(["first", "second"]), true).issue).toContain("Edit access");
  expect(followingSelection(profiles, new Set(["first", "firefox"]), false).issue).toContain("Chromium Admin");
});

test("automatic Admin choice retains Firefox followers and chooses the newest Chromium selection", () => {
  expect(followingSelection(profiles, new Set(["first", "second", "firefox"]), true, true))
    .toEqual({ adminId: "second", followerIds: ["firefox", "first"], issue: null });
  expect(followingSelection(profiles, new Set(["second", "firefox", "first"]), false, true))
    .toEqual({ adminId: "first", followerIds: ["firefox", "second"], issue: null });
  expect(followingSelection(profiles, new Set(["firefox"]), false, true).issue).toContain("at least one");
  expect(followingSelection(profiles, new Set(["first", "missing"]), false, true).issue).toContain("Open every");
});

test("a changed Admin or follower set requires reconfiguration, but follower ordering alone does not", () => {
  const state = { ...EMPTY_BROWSER_SYNC, active: true, adminId: "first", followerIds: ["second", "firefox"] };
  expect(sameFollowingSelection(state, "first", ["firefox", "second"])).toBe(true);
  expect(sameFollowingSelection(state, "second", ["first", "firefox"])).toBe(false);
  expect(sameFollowingSelection(state, "first", ["second"])).toBe(false);
  expect(sameFollowingSelection(EMPTY_BROWSER_SYNC, "first", ["second"])).toBe(false);
});
