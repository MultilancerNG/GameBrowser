import { freemem, totalmem } from "node:os";

export interface ProfileResourcePolicy {
  /** Null selects an automatic, device-local target. This is not a total-process RAM cap. */
  ramBudgetMb: number | null;
  autoOptimize: boolean;
  /** Missing preserves the browser's existing bookmarks-bar behavior. */
  alwaysShowBookmarks?: boolean;
}

export interface ResourceMemorySnapshot {
  totalMb: number;
  freeMb: number;
  /** Other currently reserved/running profiles; the allocation includes one new launch. */
  activeProfiles: number;
}

export interface ProfileResourceAllocation {
  mode: "auto" | "manual";
  budgetMb: number;
  jsHeapMb: number;
  memoryCacheKb: number;
  lowMemory: boolean;
  optimized: boolean;
  alwaysShowBookmarks?: boolean;
}

export const MIN_RESOURCE_BUDGET_MB = 128;
export const MAX_RESOURCE_BUDGET_MB = 32768;
export const DEFAULT_PROFILE_RESOURCE_POLICY: Readonly<ProfileResourcePolicy> = {
  ramBudgetMb: null,
  autoOptimize: false,
};

export function parseProfileResourcePolicy(value: unknown): ProfileResourcePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Resource settings must be an object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["ramBudgetMb", "autoOptimize", "alwaysShowBookmarks"].includes(key))) {
    throw new Error("Unknown resource setting");
  }
  if (raw.ramBudgetMb !== null && (!Number.isSafeInteger(raw.ramBudgetMb) || Number(raw.ramBudgetMb) < MIN_RESOURCE_BUDGET_MB || Number(raw.ramBudgetMb) > MAX_RESOURCE_BUDGET_MB)) {
    throw new Error(`RAM target must be Auto (null) or an integer from ${MIN_RESOURCE_BUDGET_MB} to ${MAX_RESOURCE_BUDGET_MB} MB`);
  }
  if (typeof raw.autoOptimize !== "boolean") throw new Error("Auto optimize must be true or false");
  if (raw.alwaysShowBookmarks !== undefined && typeof raw.alwaysShowBookmarks !== "boolean") throw new Error("Always show bookmarks must be true or false");
  return {
    ramBudgetMb: raw.ramBudgetMb as number | null,
    autoOptimize: raw.autoOptimize,
    ...(raw.alwaysShowBookmarks === undefined ? {} : { alwaysShowBookmarks: raw.alwaysShowBookmarks }),
  };
}

export function resourceMemorySnapshot(activeProfiles: number): ResourceMemorySnapshot {
  return {
    totalMb: Math.floor(totalmem() / 1024 / 1024),
    freeMb: Math.floor(freemem() / 1024 / 1024),
    activeProfiles: Math.max(0, Math.floor(activeProfiles)),
  };
}

function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }

/** Advisory resource targets only. Renderer heaps and caches are not whole-browser memory limits. */
export function resolveProfileResources(policy: ProfileResourcePolicy, system: ResourceMemorySnapshot): ProfileResourceAllocation {
  const normalized = parseProfileResourcePolicy(policy);
  if (!Number.isFinite(system.totalMb) || system.totalMb <= 0 || !Number.isFinite(system.freeMb) || system.freeMb < 0 ||
    !Number.isSafeInteger(system.activeProfiles) || system.activeProfiles < 0) throw new Error("Invalid system memory snapshot");
  const totalMb = Math.floor(system.totalMb);
  const freeMb = Math.min(totalMb, Math.floor(system.freeMb));
  const reserveMb = Math.max(1536, Math.ceil(totalMb * 0.2));
  const fairShareMb = Math.max(0, totalMb - reserveMb) / (system.activeProfiles + 1);
  const headroomMb = Math.max(0, freeMb - Math.max(512, Math.ceil(totalMb * 0.1)));
  const automaticMb = Math.floor(clamp(Math.min(fairShareMb, headroomMb / 2), 512, 2048) / 64) * 64;
  const budgetMb = normalized.ramBudgetMb ?? automaticMb;
  return {
    mode: normalized.ramBudgetMb === null ? "auto" : "manual",
    budgetMb,
    jsHeapMb: clamp(Math.floor((budgetMb / 2) / 64) * 64, 128, 2048),
    memoryCacheKb: clamp(Math.floor(budgetMb / 16), 16, 128) * 1024,
    lowMemory: headroomMb < budgetMb || fairShareMb < 512,
    optimized: normalized.autoOptimize,
    ...(normalized.alwaysShowBookmarks === undefined ? {} : { alwaysShowBookmarks: normalized.alwaysShowBookmarks }),
  };
}
