import type { BrowserSyncState, UiProfile } from "./api.ts";

export const EMPTY_BROWSER_SYNC: BrowserSyncState = {
  active: false, starting: false, waiting: false, saved: false, savedAdminId: null, savedFollowerIds: [], adminId: null, followerIds: [], failedFollowerIds: [], error: null,
};

type FollowingProfile = Pick<UiProfile, "id" | "engine" | "running" | "lockedBy" | "permission">;

export function followingSelection(profiles: readonly FollowingProfile[], selected: ReadonlySet<string>, cloud: boolean, automatic = false) {
  const ids = [...selected].reverse();
  // Adding a Firefox follower in automatic mode must retain a Chromium Admin.
  if (automatic) {
    const index = ids.findIndex((id) => profiles.find((profile) => profile.id === id)?.engine === "chromium");
    if (index > 0) ids.unshift(...ids.splice(index, 1));
  }
  const adminId = ids[0] ?? null;
  const followerIds = ids.slice(1);
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  let issue: string | null = null;
  if (ids.length < 2) issue = "Select an Admin and at least one follower.";
  else if (ids.length > 21) issue = "Choose one Admin and at most 20 followers.";
  else if (ids.some((id) => !byId.get(id)?.running || byId.get(id)?.lockedBy)) issue = "Open every selected browser on this computer first.";
  else if (cloud && ids.some((id) => byId.get(id)?.permission !== "edit")) issue = "Edit access is required for every selected browser.";
  else if (byId.get(adminId!)?.engine !== "chromium") issue = "Choose a Chromium Admin. Firefox profiles can follow.";
  return { adminId, followerIds, issue };
}

export function sameFollowingSelection(state: BrowserSyncState, adminId: string | null, followerIds: readonly string[]): boolean {
  return state.active && state.adminId === adminId && state.followerIds.length === followerIds.length &&
    followerIds.every((id) => state.followerIds.includes(id));
}
