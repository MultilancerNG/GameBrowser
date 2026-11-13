/** Workspace policies stay separate from AliasMode's immutable browser identity. */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { assertSafeProfileId } from "../profile-id.ts";
import { normalizeProxySpec, parseProxySpec } from "../proxy.ts";
import type { ProxySpec } from "../types.ts";
import { normalizeNetworkMode, type NetworkMode } from "./networkPolicy.ts";

export const MAX_WORKSPACE_PROFILES = 256;
export const MAX_CONCURRENT_LAUNCHES = 4;
const MAX_POLICY_FILE_BYTES = 8 * 1024 * 1024;
export interface WorkspacePolicy {
  ramMb: number;
  heapMb: number;
  /** A legacy heap value alone never enables a new observable browser limit. */
  explicitHeap?: boolean;
  headless: true;
  urls: string[];
  manual: boolean;
  /** Notify leaves the running browser and follower role untouched. */
  budgetAction: "notify" | "pause-sync" | "stop";
  /** Missing only on legacy policies; derive from the saved profile proxy. */
  networkMode?: NetworkMode;
}
export const DEFAULT_WORKSPACE_POLICY: WorkspacePolicy = {
  ramMb: 2048, heapMb: 512, explicitHeap: false, headless: true, urls: [], manual: true, budgetAction: "notify",
};

export function normalizeWorkspaceUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("workspace URL must be a string of at most 2048 characters");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("workspace URL is invalid"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("workspace pages require HTTPS (HTTP is allowed only on loopback)");
  if (url.username || url.password || url.search || url.hash) throw new Error("workspace URL must not contain credentials, a query, or a fragment");
  return url.href;
}
export function normalizeWorkspacePolicy(value: Partial<WorkspacePolicy>, fallback = DEFAULT_WORKSPACE_POLICY): WorkspacePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workspace policy must be an object");
  const merged = { ...fallback, ...value };
  if (!Number.isSafeInteger(merged.ramMb) || merged.ramMb < 512 || merged.ramMb > 65536) throw new Error("RAM budget must be an integer from 512 to 65536 MB");
  if (!Number.isSafeInteger(merged.heapMb) || merged.heapMb < 128 || merged.heapMb > 16384 || merged.heapMb > merged.ramMb) throw new Error("V8 old-space budget must be an integer from 128 to 16384 MB and no larger than the RAM budget");
  if (merged.explicitHeap !== undefined && typeof merged.explicitHeap !== "boolean") throw new Error("Explicit heap selection must be boolean");
  if (merged.headless !== true) throw new Error("workspace profiles use headless browser engines for in-browser live view");
  if (typeof merged.manual !== "boolean") throw new Error("manual mode must be boolean");
  if (merged.budgetAction !== "notify" && merged.budgetAction !== "pause-sync" && merged.budgetAction !== "stop") throw new Error("unsupported resource budget action");
  const networkMode = merged.networkMode === undefined ? undefined : normalizeNetworkMode(merged.networkMode);
  if (!Array.isArray(merged.urls) || merged.urls.length > 8) throw new Error("workspace accepts at most eight startup URLs per profile");
  return { ramMb: merged.ramMb, heapMb: merged.heapMb, explicitHeap: merged.explicitHeap ?? false, headless: true, manual: merged.manual,
    budgetAction: merged.budgetAction, urls: [...new Set(merged.urls.map(normalizeWorkspaceUrl))], ...(networkMode ? { networkMode } : {}) };
}
/** Catch parser details locally: an invalid input error must never echo credentials. */
export function parseWorkspaceProxy(value: string | ProxySpec | null | undefined): ProxySpec | null {
  try {
    if (typeof value === "string") return parseProxySpec("http", value);
    return normalizeProxySpec(value);
  } catch { throw new Error("Invalid proxy endpoint; use HTTP, HTTPS, or SOCKS5 with a valid host and port"); }
}

export class WorkspacePolicyStore {
  private readonly file: string;
  private policies = new Map<string, WorkspacePolicy>();
  constructor(stateRoot: string) {
    const directory = join(resolve(stateRoot), "workspace");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, "policies.json");
    let contents: string;
    try {
      if (statSync(this.file).size > MAX_POLICY_FILE_BYTES) throw new Error("workspace policy file is too large");
      contents = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return;
      throw new Error("Workspace policy storage is unavailable; repair it before launching profiles");
    }
    try {
      const document = JSON.parse(contents);
      if (document.version !== 1 || !Array.isArray(document.profiles) || document.profiles.length > MAX_WORKSPACE_PROFILES) throw new Error("invalid policy document");
      for (const item of document.profiles) {
        assertSafeProfileId(item.id);
        if (this.policies.has(item.id)) throw new Error("duplicate policy id");
        this.policies.set(item.id, normalizeWorkspacePolicy(item.policy));
      }
    } catch { throw new Error("Workspace policy storage is invalid; repair it before launching profiles"); }
  }
  get(id: string): WorkspacePolicy {
    assertSafeProfileId(id);
    return structuredClone(this.policies.get(id) ?? DEFAULT_WORKSPACE_POLICY);
  }
  set(id: string, policy: Partial<WorkspacePolicy>): WorkspacePolicy {
    return this.setMany([{ id, policy }])[0]!;
  }
  setMany(entries: Array<{ id: string; policy: Partial<WorkspacePolicy> }>): WorkspacePolicy[] {
    const next = new Map(this.policies);
    const normalized = entries.map(({ id, policy }) => {
      assertSafeProfileId(id);
      const result = normalizeWorkspacePolicy(policy, this.get(id));
      next.set(id, result);
      return result;
    });
    if (next.size > MAX_WORKSPACE_PROFILES) throw new Error("workspace allows at most 256 profile policies");
    this.persist(next);
    this.policies = next;
    return structuredClone(normalized);
  }
  delete(id: string): void {
    assertSafeProfileId(id);
    const next = new Map(this.policies); next.delete(id);
    this.persist(next); this.policies = next;
  }
  private persist(policies: Map<string, WorkspacePolicy>): void {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const data = JSON.stringify({ version: 1, profiles: [...policies].map(([id, policy]) => ({ id, policy })) });
    if (Buffer.byteLength(data) > MAX_POLICY_FILE_BYTES) throw new Error("workspace policy file exceeds its storage limit");
    try {
      writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.file);
    } finally { rmSync(temporary, { force: true }); }
  }
}
