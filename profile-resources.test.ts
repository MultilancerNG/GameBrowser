import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PROFILE_RESOURCE_POLICY,
  parseProfileResourcePolicy,
  resolveProfileResources,
  resourceMemorySnapshot,
} from "./profile-resources.ts";
import { ProfileStore } from "./store.ts";
import { encodePortableProfile } from "./portable-profile.ts";
import { parseExport } from "./parse.ts";

const AUTO = { ramBudgetMb: null, autoOptimize: true };
const SYSTEM = { totalMb: 8192, freeMb: 6144, activeProfiles: 0 };

test("resource settings default to an Auto recommendation without opting existing profiles into optimization", () => {
  expect(DEFAULT_PROFILE_RESOURCE_POLICY).toEqual({ ramBudgetMb: null, autoOptimize: false });
  const allocation = resolveProfileResources(DEFAULT_PROFILE_RESOURCE_POLICY, SYSTEM);
  expect(allocation).toMatchObject({ mode: "auto", budgetMb: 2048, optimized: false });
  expect("alwaysShowBookmarks" in allocation).toBe(false);
  expect(parseProfileResourcePolicy({ ramBudgetMb: null, autoOptimize: false })).toEqual(DEFAULT_PROFILE_RESOURCE_POLICY);
  expect(parseProfileResourcePolicy({ ramBudgetMb: 1024, autoOptimize: true, alwaysShowBookmarks: false }))
    .toEqual({ ramBudgetMb: 1024, autoOptimize: true, alwaysShowBookmarks: false });
});

test("resource settings reject malformed, coerced, incomplete and unknown settings", () => {
  const invalid: unknown[] = [
    null, [], "auto", {}, { ramBudgetMb: null }, { autoOptimize: true },
    { ramBudgetMb: "1024", autoOptimize: true },
    { ramBudgetMb: 1024.5, autoOptimize: true },
    { ramBudgetMb: 127, autoOptimize: true },
    { ramBudgetMb: 32769, autoOptimize: true },
    { ramBudgetMb: Infinity, autoOptimize: true },
    { ramBudgetMb: NaN, autoOptimize: true },
    { ramBudgetMb: null, autoOptimize: "true" },
    { ramBudgetMb: null, autoOptimize: true, alwaysShowBookmarks: null },
    { ramBudgetMb: null, autoOptimize: true, alwaysShowBookmarks: 1 },
    { ramBudgetMb: null, autoOptimize: true, fingerprintSeed: 100 },
  ];
  for (const value of invalid) expect(() => parseProfileResourcePolicy(value)).toThrow();
  for (const ramBudgetMb of [128, 32768]) {
    expect(parseProfileResourcePolicy({ ramBudgetMb, autoOptimize: false }).ramBudgetMb).toBe(ramBudgetMb);
  }
});

test("Auto targets share usable system RAM across current profiles and the next launch", () => {
  const one = resolveProfileResources(AUTO, SYSTEM);
  const eight = resolveProfileResources(AUTO, { ...SYSTEM, activeProfiles: 7 });
  const crowded = resolveProfileResources(AUTO, { ...SYSTEM, activeProfiles: 15 });
  expect(one.budgetMb).toBe(2048);
  expect(eight.budgetMb).toBe(768);
  expect(eight.budgetMb % 64).toBe(0);
  expect(crowded).toMatchObject({ budgetMb: 512, lowMemory: true });
  expect(eight.budgetMb).toBeLessThan(one.budgetMb);
});

test("Auto targets respond to available RAM and remain usable under memory pressure", () => {
  const constrained = resolveProfileResources(AUTO, { ...SYSTEM, freeMb: 2500 });
  const exhausted = resolveProfileResources(AUTO, { ...SYSTEM, freeMb: 100 });
  const smallDevice = resolveProfileResources(AUTO, { totalMb: 1024, freeMb: 1024, activeProfiles: 0 });
  expect(constrained).toMatchObject({ budgetMb: 832, lowMemory: false });
  expect(exhausted).toMatchObject({ budgetMb: 512, lowMemory: true });
  expect(smallDevice).toMatchObject({ budgetMb: 512, lowMemory: true });
  expect(resolveProfileResources(AUTO, { totalMb: 16384, freeMb: 16384, activeProfiles: 0 }).budgetMb).toBe(2048);
});

test("manual targets are respected while renderer heap and memory cache have independent practical limits", () => {
  expect(resolveProfileResources({ ramBudgetMb: 1024, autoOptimize: true, alwaysShowBookmarks: true }, SYSTEM))
    .toMatchObject({ mode: "manual", budgetMb: 1024, jsHeapMb: 512, memoryCacheKb: 64 * 1024, optimized: true, alwaysShowBookmarks: true });
  expect(resolveProfileResources({ ramBudgetMb: 128, autoOptimize: false }, SYSTEM))
    .toMatchObject({ budgetMb: 128, jsHeapMb: 128, memoryCacheKb: 16 * 1024, optimized: false });
  expect(resolveProfileResources({ ramBudgetMb: 32768, autoOptimize: true }, SYSTEM))
    .toMatchObject({ budgetMb: 32768, jsHeapMb: 2048, memoryCacheKb: 128 * 1024, lowMemory: true });
});

test("memory resolution rejects invalid system snapshots and host snapshots contain MB values", () => {
  for (const system of [
    { ...SYSTEM, totalMb: 0 }, { ...SYSTEM, totalMb: Infinity },
    { ...SYSTEM, freeMb: -1 }, { ...SYSTEM, freeMb: NaN },
    { ...SYSTEM, activeProfiles: -1 }, { ...SYSTEM, activeProfiles: 0.5 },
  ]) expect(() => resolveProfileResources(AUTO, system)).toThrow("Invalid system memory snapshot");
  const snapshot = resourceMemorySnapshot(2);
  expect(snapshot.activeProfiles).toBe(2);
  expect(Number.isSafeInteger(snapshot.totalMb)).toBe(true);
  expect(snapshot.totalMb).toBeGreaterThan(0);
  expect(snapshot.freeMb).toBeGreaterThanOrEqual(0);
});

test("device resource policies persist independently without changing profile identities or portable sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "gamebrowser-profile-resources-"));
  const path = join(root, "profiles.sqlite");
  let store: ProfileStore | undefined;
  try {
    store = new ProfileStore(path);
    const profile = parseExport(`id=resources1\nname=Resource profile\ngroup=Team\npassword=LOGIN_SECRET\ncookie=[{"name":"auth","value":"COOKIE_SECRET","domain":".example.com","path":"/"}]\nua=Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/143.0.0.0 Safari/537.36\nresolution=1680*1050\n******************`).profiles[0]!;
    store.upsertProfile(profile);
    const before = structuredClone(store.getProfile(profile.id)!);
    const portable = encodePortableProfile(before);
    const policy = { ramBudgetMb: 1536, autoOptimize: true, alwaysShowBookmarks: false };
    store.setProfileResourcePolicy(profile.id, policy);
    expect(store.getProfile(profile.id)).toEqual(before);
    expect(encodePortableProfile(store.getProfile(profile.id)!)).toEqual(portable);
    expect(store.getProfileResourcePolicy(profile.id)).toEqual(policy);
    store.close();
    store = new ProfileStore(path);
    expect(store.getProfileResourcePolicy(profile.id)).toEqual(policy);
    expect(encodePortableProfile(store.getProfile(profile.id)!)).toEqual(portable);
    const otherDevice = new ProfileStore(":memory:");
    try {
      otherDevice.upsertProfile(before);
      expect(otherDevice.getProfileResourcePolicy(profile.id)).toEqual(DEFAULT_PROFILE_RESOURCE_POLICY);
    } finally { otherDevice.close(); }
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resource policies can be saved for authorized closed Cloud IDs without creating a cached profile", () => {
  const store = new ProfileStore(":memory:");
  try {
    store.setProfileResourcePolicy("cloud_closed", { ramBudgetMb: null, autoOptimize: true });
    expect(store.getProfile("cloud_closed")).toBeNull();
    expect(store.listProfiles()).toHaveLength(0);
    expect(store.getProfileResourcePolicy("cloud_closed")).toEqual({ ramBudgetMb: null, autoOptimize: true });
    const fresh = store.getProfileResourcePolicy("unconfigured");
    fresh.autoOptimize = true;
    expect(store.getProfileResourcePolicy("unconfigured")).toEqual(DEFAULT_PROFILE_RESOURCE_POLICY);
    expect(() => store.setProfileResourcePolicy("../bad", { ramBudgetMb: null, autoOptimize: true })).toThrow();
    expect(() => store.setProfileResourcePolicy("invalid_settings", { ramBudgetMb: -1, autoOptimize: true })).toThrow();
  } finally { store.close(); }
});

test("corrupt device resource preferences fall back to an unoptimized default", () => {
  const root = mkdtempSync(join(tmpdir(), "gamebrowser-corrupt-resources-"));
  const path = join(root, "profiles.sqlite");
  try {
    const initial = new ProfileStore(path);
    initial.close();
    const db = new Database(path);
    db.query("INSERT INTO profile_resource_policies (profile_id, policy_json) VALUES (?, ?)").run("broken_json", "{");
    db.query("INSERT INTO profile_resource_policies (profile_id, policy_json) VALUES (?, ?)").run("broken_policy", JSON.stringify({ ramBudgetMb: 1024, autoOptimize: "true" }));
    db.close();
    const reopened = new ProfileStore(path);
    try {
      expect(reopened.getProfileResourcePolicy("broken_json")).toEqual(DEFAULT_PROFILE_RESOURCE_POLICY);
      expect(reopened.getProfileResourcePolicy("broken_policy")).toEqual(DEFAULT_PROFILE_RESOURCE_POLICY);
    } finally { reopened.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
