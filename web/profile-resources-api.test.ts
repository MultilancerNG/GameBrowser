import { afterEach, expect, test } from "bun:test";
import { fetchProfileResources, saveProfileResources } from "./api.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function resourceResponse() {
  return {
    ok: true,
    policy: { ramBudgetMb: null, autoOptimize: false },
    allocation: {
      mode: "auto", budgetMb: 1536, jsHeapMb: 768, memoryCacheKb: 96 * 1024,
      lowMemory: false, optimized: false,
    },
    system: { totalMb: 8192, freeMb: 6144, activeProfiles: 1 },
    appliesNextLaunch: true,
  };
}

test("profile resources load through an encoded same-origin path and forward cancellation", async () => {
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return Response.json(resourceResponse());
  }) as unknown as typeof fetch;
  const controller = new AbortController();
  const state = await fetchProfileResources("profile/id ?#", controller.signal);
  expect(calls[0]?.input).toBe("/ui/api/profiles/profile%2Fid%20%3F%23/resources");
  expect(calls[0]?.init?.signal).toBe(controller.signal);
  expect(state.policy).toEqual({ ramBudgetMb: null, autoOptimize: false });
  expect(state.allocation).toMatchObject({ mode: "auto", budgetMb: 1536, optimized: false });
  expect(state.system).toEqual({ totalMb: 8192, freeMb: 6144, activeProfiles: 1 });
  expect(state.appliesNextLaunch).toBe(true);
});

test("saving RAM settings sends JSON without introducing a bookmarks override", async () => {
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    const response = resourceResponse();
    return Response.json({ ...response, policy: JSON.parse(String(init?.body)) });
  }) as unknown as typeof fetch;
  const controller = new AbortController();
  const policy = { ramBudgetMb: 1024, autoOptimize: true };
  const state = await saveProfileResources("profile/id", policy, controller.signal);
  expect(calls[0]?.input).toBe("/ui/api/profiles/profile%2Fid/resources");
  expect(calls[0]?.init?.method).toBe("POST");
  expect(calls[0]?.init?.headers).toEqual({ "Content-Type": "application/json" });
  expect(calls[0]?.init?.signal).toBe(controller.signal);
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(policy);
  expect(state.policy).toEqual(policy);
  await saveProfileResources("profile1", { ...policy, alwaysShowBookmarks: false });
  expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ ...policy, alwaysShowBookmarks: false });
});

test("profile resources report server errors for both load and save", async () => {
  for (const status of [200, 403, 503]) {
    globalThis.fetch = (async () => Response.json({ ok: false, error: "Profile edit access is required" }, { status })) as unknown as typeof fetch;
    await expect(fetchProfileResources("profile1")).rejects.toThrow("Profile edit access is required");
    await expect(saveProfileResources("profile1", { ramBudgetMb: null, autoOptimize: false }))
      .rejects.toThrow("Profile edit access is required");
  }
  globalThis.fetch = (async () => Response.json(resourceResponse(), { status: 503 })) as unknown as typeof fetch;
  await expect(fetchProfileResources("profile1")).rejects.toThrow();
});

test("profile resources reject malformed settings and allocations before the UI consumes them", async () => {
  const valid = resourceResponse();
  const malformed: unknown[] = [
    null,
    { ok: true },
    { ...valid, policy: null },
    { ...valid, policy: { ramBudgetMb: "1024", autoOptimize: false } },
    { ...valid, policy: { ramBudgetMb: 1024.5, autoOptimize: false } },
    { ...valid, policy: { ramBudgetMb: 32769, autoOptimize: false } },
    { ...valid, policy: { ramBudgetMb: Number.MAX_SAFE_INTEGER + 1, autoOptimize: false } },
    { ...valid, policy: { ramBudgetMb: null, autoOptimize: "false" } },
    { ...valid, policy: { ramBudgetMb: null, autoOptimize: false, alwaysShowBookmarks: null } },
    { ...valid, allocation: null },
    { ...valid, allocation: { ...valid.allocation, mode: "dynamic" } },
    { ...valid, allocation: { ...valid.allocation, budgetMb: -1 } },
    { ...valid, allocation: { ...valid.allocation, jsHeapMb: "768" } },
    { ...valid, allocation: { ...valid.allocation, memoryCacheKb: 1.5 } },
    { ...valid, allocation: { ...valid.allocation, lowMemory: "false" } },
    { ...valid, allocation: { ...valid.allocation, optimized: null } },
    { ...valid, system: { ...valid.system, totalMb: 0 } },
    { ...valid, system: { ...valid.system, freeMb: -1 } },
    { ...valid, system: { ...valid.system, activeProfiles: 0.5 } },
    { ...valid, appliesNextLaunch: false },
  ];
  for (const body of malformed) {
    globalThis.fetch = (async () => Response.json(body)) as unknown as typeof fetch;
    await expect(fetchProfileResources("profile1")).rejects.toThrow();
  }
  globalThis.fetch = (async () => Response.json({ ...valid, allocation: { ...valid.allocation, mode: "invalid" } })) as unknown as typeof fetch;
  await expect(saveProfileResources("profile1", { ramBudgetMb: null, autoOptimize: false })).rejects.toThrow();
});

test("profile resource responses tolerate additional server metadata", async () => {
  const valid = resourceResponse();
  globalThis.fetch = (async () => Response.json({
    ...valid, serverVersion: "future", policy: { ...valid.policy, futurePolicyMetadata: true },
    allocation: { ...valid.allocation, futureAllocationMetadata: true },
    system: { ...valid.system, futureSystemMetadata: true },
  })) as unknown as typeof fetch;
  const state = await fetchProfileResources("profile1");
  expect(state.policy).toMatchObject(valid.policy);
  expect(state.allocation).toMatchObject(valid.allocation);
  expect(state.system).toMatchObject(valid.system);
});
