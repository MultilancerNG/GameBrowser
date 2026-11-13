import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_WORKSPACE_POLICY, normalizeWorkspacePolicy, WorkspacePolicyStore } from "./profileStore.ts";

test("workspace RAM observation does not opt profiles into stopping, pausing or a visible heap override", () => {
  expect(DEFAULT_WORKSPACE_POLICY.budgetAction).toBe("notify");
  expect(normalizeWorkspacePolicy({})).toMatchObject({ budgetAction: "notify", explicitHeap: false });
  expect(normalizeWorkspacePolicy({ heapMb: 768 })).toMatchObject({ explicitHeap: false, heapMb: 768 });
  expect(normalizeWorkspacePolicy({ heapMb: 768, explicitHeap: true })).toMatchObject({ explicitHeap: true, heapMb: 768 });
  expect(normalizeWorkspacePolicy({ budgetAction: "pause-sync" }).budgetAction).toBe("pause-sync");
  expect(normalizeWorkspacePolicy({ budgetAction: "stop" }).budgetAction).toBe("stop");
  expect(() => normalizeWorkspacePolicy({ explicitHeap: "true" as any })).toThrow("boolean");
});

test("legacy numeric heap values remain advisory after policy reopen until an explicit opt-in is saved", () => {
  const root = mkdtempSync(join(tmpdir(), "gamebrowser-workspace-policy-"));
  try {
    mkdirSync(join(root, "workspace"));
    writeFileSync(join(root, "workspace", "policies.json"), JSON.stringify({ version: 1, profiles: [{ id: "profile-old", policy: {
      ramMb: 2048, heapMb: 512, headless: true, urls: [], manual: false,
    } }] }));
    const policy = new WorkspacePolicyStore(root);
    expect(policy.get("profile-old")).toMatchObject({ heapMb: 512, explicitHeap: false, budgetAction: "notify", manual: false });
    policy.set("profile-old", { heapMb: 1024, explicitHeap: true, budgetAction: "notify" });
    const reopened = new WorkspacePolicyStore(root);
    expect(reopened.get("profile-old")).toMatchObject({ heapMb: 1024, explicitHeap: true, budgetAction: "notify", manual: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
