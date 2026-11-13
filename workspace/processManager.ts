/** The workspace delegates spawning/teardown to the identity-certified Launcher. */
import { warmWindowsProcessService, type Launcher, type LaunchGeneration, type LaunchStartOptions } from "../launcher.ts";
import { bundleTabUrls } from "../session.ts";
import { resourceMemorySnapshot, resolveProfileResources } from "../profile-resources.ts";
import { buildNewProfile } from "../create.ts";
import { assertSafeProfileId } from "../profile-id.ts";
import type { ProfileStore } from "../store.ts";
import type { LaunchInfo, Profile, ProfileEngine, ProxySpec } from "../types.ts";
import { launchGeneration, ResourceMonitor, type ResourceMetrics } from "./resourceMonitor.ts";
import { MAX_CONCURRENT_LAUNCHES, MAX_WORKSPACE_PROFILES, normalizeWorkspacePolicy, parseWorkspaceProxy, WorkspacePolicyStore, type WorkspacePolicy } from "./profileStore.ts";
import { effectiveProfileProxy, legacyNetworkMode, networkSummary, normalizeNetworkMode, type NetworkMode, type NetworkUpdate } from "./networkPolicy.ts";
import { parseDesktopResolution, validateDesktopProfile, validateDesktopScreen, withDesktopScreen } from "./displayPolicy.ts";

type WorkspaceLauncher = Pick<Launcher, "start" | "stop"> & {
  /** Added by StakeMode to retain generation checks while skipping graceful close. */
  forceStop?: (id: string, expected?: LaunchGeneration) => Promise<boolean>;
  profileDeletionBlocked?: (id: string) => boolean;
  removeProfileData?: (id: string, afterRemoval?: () => void | Promise<void>) => Promise<void>;
};
export type WorkspaceIdentityStore = Pick<ProfileStore, "getProfile" | "listProfiles" | "getLaunch" | "listLaunches" | "upsertProfiles" | "deleteProfile"> & Partial<Pick<ProfileStore, "isTrashed" | "getProfileResourcePolicy" | "hasFingerprintSeed" | "getSessionBundle">>;
export interface BulkProfileInput {
  count: number;
  prefix?: string;
  engine?: ProfileEngine;
  urls?: string[];
  origin?: string;
  proxies?: Array<string | ProxySpec | null>;
  ramMb?: number;
  heapMb?: number;
  resolutions?: Array<string | { width: number; height: number }>;
  headless?: true;
  networkMode?: NetworkMode;
}
export interface WorkspaceProfileView {
  id: string; name: string; engine: ProfileEngine;
  proxy: { type: string; host: string; port: string } | null;
  networkMode: NetworkMode; networkSummary: string;
  screenWidth: number; screenHeight: number;
  ramMb: number; heapMb: number; headless: true; urls: string[]; manual: boolean;
  state: "stopped" | "starting" | "running" | "manual" | "stopping" | "error";
  pid: number | null; cpuPercent: number | null; memoryMb: number | null; processCount: number | null;
  metricsVerified: boolean; metricsSampledAt: number | null; overBudget: boolean;
  resourcePolicy: "monitored"; budgetAction: WorkspacePolicy["budgetAction"];
  resourceSettings?: ReturnType<ProcessManager["resourceSettings"]>;
  lastError?: string;
}
export interface ProcessManagerOptions {
  launcher: WorkspaceLauncher;
  store: WorkspaceIdentityStore;
  stateRoot: string;
  concurrentLaunches?: number;
  /** Cloud identity writes use the existing Cloud profile editor, never the local cache. */
  readOnlyIdentity?: boolean;
  externalProfiles?: () => Array<Pick<WorkspaceProfileView, "id" | "name" | "engine" | "screenWidth" | "screenHeight">>;
  authorize?: () => void;
  lifecycle?: {
    start(id: string, options: LaunchStartOptions, urls: string[]): Promise<void>;
    stop(id: string, force: boolean): Promise<boolean>;
  };
  beforeStart?: (id: string, profile: Profile) => void | Promise<void>;
  afterDelete?: (id: string) => void | Promise<void>;
  /** The real Windows service is warmed before any first browser spawn. */
  warmProcessService?: () => Promise<boolean>;
  /** Injectable exact resource sampler for deterministic integration tests. */
  monitorFactory?: (options: ConstructorParameters<typeof ResourceMonitor>[0]) => Pick<ResourceMonitor, "start" | "dispose">;
}
export class ProcessManager {
  private readonly policy: WorkspacePolicyStore;
  private readonly monitor: Pick<ResourceMonitor, "start" | "dispose">;
  private listeners = new Set<(profiles: WorkspaceProfileView[]) => void>();
  private phases = new Map<string, "starting" | "stopping" | "error">();
  private errors = new Map<string, string>();
  private metrics = new Map<string, ResourceMetrics>();
  private starts = new Map<string, Promise<WorkspaceProfileView>>();
  private stops = new Map<string, Promise<boolean>>();
  private startAfterStop = new Map<string, Promise<boolean>>();
  private budgetStops = new Set<string>();
  private consecutiveOverBudget = new Map<string, number>();
  private budgetPaused = new Set<string>();
  private launchSlots = 0;
  private launchQueue: Array<() => void> = [];
  private readonly limit: number;
  private disposed = false;
  private startsClosed = false;
  private deleting = new Set<string>();
  private processServiceWarm = false;
  private warmingProcessService?: Promise<boolean>;
  constructor(private readonly options: ProcessManagerOptions) {
    this.policy = new WorkspacePolicyStore(options.stateRoot);
    this.limit = options.concurrentLaunches ?? MAX_CONCURRENT_LAUNCHES;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1 || this.limit > MAX_CONCURRENT_LAUNCHES) throw new Error("concurrent launches must be from 1 to 4");
    const monitorOptions = { launches: () => options.store.listLaunches(), onMetrics: (rows: ResourceMetrics[]) => this.acceptMetrics(rows) };
    this.monitor = options.monitorFactory?.(monitorOptions) ?? new ResourceMonitor(monitorOptions);
    this.monitor.start();
  }
  list(): WorkspaceProfileView[] {
    if (this.options.externalProfiles) return this.options.externalProfiles().map(summary => {
      const profile = this.options.store.getProfile(summary.id);
      if (profile) return this.view(profile);
      const policy = this.policy.get(summary.id);
      return { ...summary, ...policy, resourceSettings: this.resourceSettings(summary.id), proxy: null, networkMode: policy.networkMode ?? "direct", networkSummary: "Cloud route available after opening",
        state: this.phases.get(summary.id) ?? "stopped", pid: null, cpuPercent: null, memoryMb: null, processCount: null,
        metricsVerified: false, metricsSampledAt: null, overBudget: false, resourcePolicy: "monitored" as const,
        ...(this.errors.has(summary.id) ? { lastError: this.errors.get(summary.id) } : {}) };
    });
    return this.options.store.listProfiles().map(profile => this.view(profile));
  }
  getProfile(id: string): WorkspaceProfileView | null {
    assertSafeProfileId(id);
    if (this.options.externalProfiles) return this.list().find(profile => profile.id === id) ?? null;
    const profile = this.options.store.getProfile(id);
    return profile ? this.view(profile) : null;
  }
  /** Private launch control data: never serialize this object into the dashboard. */
  getLaunch(id: string): LaunchInfo | null { assertSafeProfileId(id); return this.options.store.getLaunch(id); }
  resourceSettings(id: string) {
    const policy = this.options.store.getProfileResourcePolicy?.(id);
    if (!policy) return undefined;
    const others = new Set([...this.options.store.listLaunches().map(launch => launch.profileId), ...this.starts.keys()]); others.delete(id);
    const system = resourceMemorySnapshot(others.size);
    return { policy, allocation: resolveProfileResources(policy, system), system, appliesNextLaunch: true };
  }
  private monitoredBudget(id: string): number {
    const resources = this.resourceSettings(id);
    return resources && (resources.policy.autoOptimize || resources.policy.ramBudgetMb !== null) ? resources.allocation.budgetMb : this.policy.get(id).ramMb;
  }
  getResourceLimits(id: string): { v8OldSpaceMb: number; deviceScaleFactor: 1 } | undefined {
    this.requireProfile(id); const policy = this.policy.get(id);
    return policy.explicitHeap && !this.options.store.getProfileResourcePolicy?.(id).autoOptimize ? { v8OldSpaceMb: policy.heapMb, deviceScaleFactor: 1 } : undefined;
  }
  getNetworkMode(id: string): NetworkMode { const profile = this.requireProfile(id); return this.policy.get(id).networkMode ?? legacyNetworkMode(profile); }
  canEditProfile(id: string): boolean {
    assertSafeProfileId(id);
    return !this.options.readOnlyIdentity && !!this.options.store.getProfile(id) && !this.disposed && !this.startsClosed && !this.getLaunch(id) && !this.starts.has(id)
      && !this.stops.has(id) && !this.deleting.has(id) && !this.options.launcher.profileDeletionBlocked?.(id);
  }
  onChange(listener: (profiles: WorkspaceProfileView[]) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async bulkCreate(input: BulkProfileInput): Promise<WorkspaceProfileView[]> {
    this.assertOpen(); this.assertIdentityWritable();
    if (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > MAX_WORKSPACE_PROFILES) throw new Error("profile count must be from 1 to 256");
    if (this.options.store.listProfiles().length + input.count > MAX_WORKSPACE_PROFILES) throw new Error("workspace allows at most 256 profiles");
    const engine = input.engine ?? "chromium";
    if (engine !== "chromium" && engine !== "firefox") throw new Error("unsupported browser engine");
    const prefix = input.prefix?.trim() || "Profile";
    if (prefix.length > 80 || /[\u0000-\u001f\u007f]/.test(prefix)) throw new Error("profile name prefix must be at most 80 printable characters");
    if (input.proxies && (!Array.isArray(input.proxies) || input.proxies.length > MAX_WORKSPACE_PROFILES)) throw new Error("invalid proxy list");
    // One proxy may be deliberately shared; otherwise every row is explicit.
    if (input.proxies?.length && input.proxies.length !== 1 && input.proxies.length !== input.count) throw new Error("supply one shared proxy or exactly one proxy per new profile");
    const proxies = (input.proxies ?? []).map(parseWorkspaceProxy);
    const requestedNetworkMode = input.networkMode === undefined ? undefined : normalizeNetworkMode(input.networkMode);
    const resolutions = input.resolutions ?? ["1366x768", "1536x864", "1920x1080"];
    if (!Array.isArray(resolutions) || !resolutions.length || resolutions.length > 64) throw new Error("supply 1 to 64 resolution presets");
    const screens = resolutions.map(parseDesktopResolution);
    const basePolicy = normalizeWorkspacePolicy({ ...input.ramMb !== undefined && { ramMb: input.ramMb },
      ...input.heapMb !== undefined && { heapMb: input.heapMb }, headless: input.headless ?? true,
      urls: input.urls ?? (input.origin ? [input.origin] : []), manual: true, explicitHeap: input.heapMb !== undefined });
    const profiles: Profile[] = [];
    const seeds = new Set<number>();
    const ids = new Set(this.options.store.listProfiles().map((profile) => profile.id));
    for (let index = 0; index < input.count; index++) {
      const screen = screens[index % screens.length]!;
      const profile = withDesktopScreen(buildNewProfile({ engine, name: `${prefix} ${index + 1}`, group: "GameBrowser Workspace",
        proxy: proxies.length === 1 ? proxies[0] : proxies[index] ?? null, screen: `${screen.width}x${screen.height}` },
      (id) => ids.has(id) || this.options.store.isTrashed?.(id) === true,
      seed => seeds.has(seed) || this.options.store.hasFingerprintSeed?.(seed) === true), screen);
      ids.add(profile.id); seeds.add(profile.fingerprintSeed); profiles.push(profile);
      effectiveProfileProxy(profile, requestedNetworkMode ?? legacyNetworkMode(profile));
    }
    // Validate every row before the atomic identity-store transaction.
    this.options.store.upsertProfiles(profiles);
    try { this.policy.setMany(profiles.map((profile) => ({ id: profile.id, policy: { ...basePolicy, networkMode: requestedNetworkMode ?? legacyNetworkMode(profile) } }))); }
    catch (error) { for (const profile of profiles) this.options.store.deleteProfile(profile.id); throw error; }
    this.notify();
    return profiles.map((profile) => this.view(this.options.store.getProfile(profile.id)!));
  }
  setPolicy(id: string, value: Partial<Pick<WorkspacePolicy, "ramMb" | "heapMb" | "urls" | "budgetAction">>): WorkspaceProfileView {
    this.assertOpen(); this.requireProfile(id);
    if (!this.canEditProfile(id)) throw new Error("stop the profile before changing its resource or startup policy");
    // Do not let the generic policy endpoint bypass network validation.
    const allowed = Object.fromEntries(Object.entries(value).filter(([key]) => ["ramMb", "heapMb", "urls", "budgetAction"].includes(key)));
    this.policy.set(id, { ...allowed, ...(Object.hasOwn(allowed, "heapMb") ? { explicitHeap: true } : {}) }); this.notify(); return this.getProfile(id)!;
  }
  updateNetwork(id: string, value: NetworkUpdate): WorkspaceProfileView {
    this.assertOpen(); const profile = this.requireProfile(id);
    if (!this.canEditProfile(id)) throw new Error("stop the profile before changing its network route");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("network update must be an object");
    const mode = normalizeNetworkMode(value.networkMode);
    const replaceProxy = Object.hasOwn(value, "proxy");
    const updated = replaceProxy ? { ...profile, proxy: parseWorkspaceProxy(value.proxy), proxyError: undefined } : profile;
    effectiveProfileProxy(updated, mode);
    if (replaceProxy) this.options.store.upsertProfiles([updated]);
    try { this.policy.set(id, { networkMode: mode, manual: true }); }
    catch (error) { if (replaceProxy) this.options.store.upsertProfiles([profile]); throw error; }
    this.metrics.delete(id); this.notify(); return this.getProfile(id)!;
  }
  updateScreen(id: string, value: unknown): WorkspaceProfileView {
    this.assertOpen(); const profile = this.requireProfile(id);
    if (!this.canEditProfile(id)) throw new Error("stop the profile before changing its desktop screen");
    const screen = validateDesktopScreen(value);
    this.options.store.upsertProfiles([withDesktopScreen(profile, screen)]);
    this.metrics.delete(id); this.notify(); return this.getProfile(id)!;
  }
  renameProfile(id: string, name: string): WorkspaceProfileView {
    this.assertOpen(); const profile = this.requireProfile(id);
    if (!this.canEditProfile(id)) throw new Error("stop the profile before changing its name");
    if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("profile name must contain 2 to 80 printable characters");
    this.options.store.upsertProfiles([{ ...profile, name: name.trim() }]); this.notify(); return this.getProfile(id)!;
  }
  async copyProfile(id: string, name?: string): Promise<WorkspaceProfileView> {
    this.assertOpen(); this.assertIdentityWritable(); const profile = this.requireProfile(id);
    if (this.deleting.has(id)) throw new Error("profile deletion is in progress");
    const nextName = name === undefined ? `${profile.name.slice(0, 75)} copy` : name;
    if (typeof nextName !== "string" || nextName.trim().length < 2 || nextName.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(nextName)) throw new Error("profile name must contain 2 to 80 printable characters");
    const policy = this.policy.get(id), mode = this.getNetworkMode(id);
    // Retain endpoint routing, never stored proxy or account authentication.
    const endpoint = profile.proxy ? { ...profile.proxy, user: "", pass: "" } : null;
    if (mode === "proxy" && !endpoint) throw new Error("repair the source proxy before copying this profile");
    if (this.options.store.listProfiles().length >= MAX_WORKSPACE_PROFILES) throw new Error("workspace allows at most 256 profiles");
    let created = buildNewProfile({ name: nextName.trim(), engine: profile.engine ?? "chromium", group: "GameBrowser Workspace",
      screen: `${profile.screenWidth}x${profile.screenHeight}`, proxy: endpoint }, candidate => !!this.options.store.getProfile(candidate) || this.options.store.isTrashed?.(candidate) === true,
      seed => this.options.store.hasFingerprintSeed?.(seed) === true);
    effectiveProfileProxy(created, mode);
    if (profile.engine === "firefox" && profile.firefox) {
      if (!created.firefox) throw new Error("copied Firefox identity is missing");
      // Browserforge chooses a monitor around the requested window size. Keep
      // the source monitor/window geometry while generating the other identity
      // inputs afresh; never copy cookies, credentials, or addon paths.
      const geometry = Object.fromEntries(Object.entries(profile.firefox.config).filter(([key]) => key.startsWith("screen.")
        || /^window\.(?:screenX|screenY|outerWidth|outerHeight|innerWidth|innerHeight|devicePixelRatio)$/.test(key)));
      created = { ...created, screenWidth: profile.screenWidth, screenHeight: profile.screenHeight,
        firefox: { ...created.firefox, config: { ...created.firefox.config, ...geometry } } };
    }
    // Publish one complete identity, never a temporary copy that observers can
    // start before its geometry and policy have been finalized.
    created = withDesktopScreen(created, { width: profile.screenWidth, height: profile.screenHeight });
    this.options.store.upsertProfiles([created]);
    try { this.policy.set(created.id, { ...policy, networkMode: mode, manual: true }); }
    catch (error) { this.options.store.deleteProfile(created.id); throw error; }
    this.notify(); return this.getProfile(created.id)!;
  }
  async deleteProfile(id: string): Promise<{ deleted: true; profileId: string }> {
    this.assertOpen(); this.requireProfile(id);
    if (!this.canEditProfile(id)) throw new Error("stop the profile and finish its lifecycle operation before deleting local profile data");
    if (!this.options.launcher.removeProfileData) throw new Error("native profile ownership verification is unavailable; deletion is blocked");
    this.deleting.add(id);
    try {
      await this.options.launcher.removeProfileData(id, async () => {
        // The Launcher mutation lock remains held through all local metadata removal.
        if (this.getLaunch(id) || this.starts.has(id) || this.stops.has(id)) throw new Error("profile lifecycle changed during deletion");
        await this.options.afterDelete?.(id);
        this.policy.delete(id);
        if (!this.options.store.deleteProfile(id)) throw new Error("profile metadata could not be removed");
      });
      this.errors.delete(id); this.phases.delete(id); this.metrics.delete(id); this.budgetPaused.delete(id); this.consecutiveOverBudget.delete(id);
      this.notify(); return { deleted: true, profileId: id };
    } finally { this.deleting.delete(id); }
  }
  start(id: string): Promise<WorkspaceProfileView> {
    this.assertCanStart(); if (!this.options.lifecycle) validateDesktopProfile(this.requireProfile(id)); else if (!this.getProfile(id)) throw new Error("profile was not found");
    if (this.deleting.has(id)) throw new Error("profile deletion is in progress");
    const pending = this.starts.get(id), predecessor = this.stops.get(id);
    if (pending && (!predecessor || this.startAfterStop.get(id) === predecessor)) return pending;
    let task!: Promise<WorkspaceProfileView>;
    task = Promise.resolve().then(async () => {
      if (predecessor && !await predecessor && this.getLaunch(id)) throw new Error("previous browser shutdown remains unconfirmed");
      this.phases.set(id, "starting"); this.errors.delete(id); this.notify();
      await this.acquireLaunchSlot();
      try {
        this.assertCanStart();
        const profile = this.options.store.getProfile(id), policy = this.policy.get(id);
        if (!profile && !this.options.lifecycle) throw new Error("profile was not found");
        const previousLaunch = this.getLaunch(id);
        if (previousLaunch && previousLaunch.headless !== true) throw new Error("Close the native browser before opening it in Live workspace");
        await this.ensureProcessServiceWarm();
        this.assertCanStart();
        if (profile) await this.options.beforeStart?.(id, profile);
        this.assertCanStart();
        // These trusted limits are distinct from arbitrary forwarded launch_args.
        const options: LaunchStartOptions & { networkMode?: NetworkMode; resourceLimits?: { v8OldSpaceMb: number; deviceScaleFactor: 1 } } = {
          headless: true, autoNavigate: true, restoreLastSession: true,
          ...(profile ? { networkMode: this.getNetworkMode(id) } : {}),
          ...((profile?.engine ?? this.getProfile(id)?.engine) !== "firefox" && policy.explicitHeap ? { resourceLimits: { v8OldSpaceMb: policy.heapMb, deviceScaleFactor: 1 } } : {}),
        };
        const savedTabs = bundleTabUrls(this.options.store.getSessionBundle?.(id) ?? "");
        const startupUrls = previousLaunch || savedTabs.length ? [] : policy.urls;
        if (this.options.lifecycle) await this.options.lifecycle.start(id, options, startupUrls);
        else await this.options.launcher.start(id, startupUrls, options);
        const launch = this.getLaunch(id);
        if (!launch || launch.headless !== true) throw new Error("workspace requires a verified headless launch generation");
        if (!previousLaunch || launchGeneration(previousLaunch) !== launchGeneration(launch)) {
          this.metrics.delete(id); this.consecutiveOverBudget.delete(id); this.budgetPaused.delete(id);
        }
        this.phases.delete(id); this.notify();
        return this.getProfile(id)!;
      } catch {
        this.phases.set(id, "error"); this.errors.set(id, "Browser launch failed; check the native runtime status and local application log"); this.notify();
        throw new Error(this.errors.get(id));
      } finally { this.releaseLaunchSlot(); }
    }).finally(() => { if (this.starts.get(id) === task) { this.starts.delete(id); this.startAfterStop.delete(id); } });
    this.starts.set(id, task); if (predecessor) this.startAfterStop.set(id, predecessor); else this.startAfterStop.delete(id);
    return task;
  }
  private async ensureProcessServiceWarm(): Promise<void> {
    if (this.processServiceWarm) return;
    const task = this.warmingProcessService ??= Promise.resolve().then(this.options.warmProcessService ?? warmWindowsProcessService)
      .then(ready => { this.processServiceWarm = ready === true; return this.processServiceWarm; }).catch(() => false);
    try {
      if (!await task) throw new Error("Native process inspection is unavailable; retry after the local service recovers");
    } finally { if (this.warmingProcessService === task) this.warmingProcessService = undefined; }
  }
  stop(id: string): Promise<boolean> { return this.stopProfile(id, false); }
  forceKill(id: string): Promise<boolean> { return this.stopProfile(id, true); }
  private stopProfile(id: string, force: boolean): Promise<boolean> {
    this.assertOpen(); this.requireProfile(id);
    if (this.deleting.has(id)) throw new Error("profile deletion is in progress");
    const stopping = this.stops.get(id), starting = this.starts.get(id);
    const queuedAfterExistingStop = !!stopping && !!starting && this.startAfterStop.get(id) === stopping;
    if (stopping && !queuedAfterExistingStop) return stopping;
    let task!: Promise<boolean>;
    task = Promise.resolve().then(async () => {
      if (stopping) await stopping;
      if (starting) await starting.catch(() => {});
      const launch = this.getLaunch(id);
      this.phases.set(id, "stopping"); this.notify();
      try {
        const expected = launch ? { startedAt: launch.startedAt, debugPort: launch.debugPort } : undefined;
        if (force && !this.options.lifecycle && !this.options.launcher.forceStop) throw new Error("native ownership-aware force stop is unavailable");
        const stopped = this.options.lifecycle ? await this.options.lifecycle.stop(id, force)
          : force ? await this.options.launcher.forceStop!(id, expected) : await this.options.launcher.stop(id, expected);
        if (!stopped || this.getLaunch(id)) throw new Error("native teardown could not be confirmed");
        this.phases.delete(id); this.errors.delete(id); this.metrics.delete(id); this.consecutiveOverBudget.delete(id); this.budgetPaused.delete(id); this.notify(); return true;
      } catch {
        this.phases.set(id, "error"); this.errors.set(id, "Browser shutdown could not be confirmed; the owned launch remains quarantined"); this.notify(); return false;
      }
    }).finally(() => { if (this.stops.get(id) === task) this.stops.delete(id); });
    this.stops.set(id, task); return task;
  }
  setManual(id: string, manual: boolean): WorkspaceProfileView {
    this.assertOpen(); if (!this.getProfile(id)) throw new Error("profile was not found");
    if (this.deleting.has(id)) throw new Error("profile deletion is in progress");
    if (typeof manual !== "boolean") throw new Error("manual mode must be boolean");
    const current = this.getProfile(id)!;
    if (!manual && current.overBudget && current.budgetAction !== "notify") throw new Error("profile exceeds its monitored RAM budget; stop or reduce usage before resuming sync");
    this.policy.set(id, { manual }); if (!manual) this.budgetPaused.delete(id); this.notify(); return this.getProfile(id)!;
  }
  private acceptMetrics(rows: ResourceMetrics[]): void {
    if (this.disposed) return;
    for (const metric of rows) {
      const launch = this.getLaunch(metric.profileId);
      if (!launch || launchGeneration(launch) !== metric.generation) continue;
      this.metrics.set(metric.profileId, metric);
      const policy = this.policy.get(metric.profileId);
      const over = metric.verified && metric.memoryMb !== null && metric.memoryMb > this.monitoredBudget(metric.profileId);
      const count = over ? (this.consecutiveOverBudget.get(metric.profileId) ?? 0) + 1 : 0;
      this.consecutiveOverBudget.set(metric.profileId, count);
      // Require two samples to absorb short startup allocations; pause happens
      // immediately on the first sample, and optional stop follows sustained use.
      if (over && policy.budgetAction !== "notify") {
        this.budgetPaused.add(metric.profileId);
        if (!policy.manual) {
          try { this.policy.set(metric.profileId, { manual: true }); }
          catch { this.errors.set(metric.profileId, "RAM budget exceeded; sync paused, but the policy could not be saved"); }
        }
      }
      if (count >= 2 && policy.budgetAction === "stop" && !this.budgetStops.has(metric.profileId)) {
        this.budgetStops.add(metric.profileId);
        void this.stop(metric.profileId).finally(() => { this.budgetStops.delete(metric.profileId); });
      }
    }
    this.notify();
  }
  private view(profile: Profile): WorkspaceProfileView {
    const savedPolicy = this.policy.get(profile.id), launch = this.getLaunch(profile.id), metrics = this.metrics.get(profile.id);
    const policy = { ...savedPolicy, manual: savedPolicy.manual || this.budgetPaused.has(profile.id) };
    const current = launch && metrics?.generation === launchGeneration(launch) ? metrics : undefined;
    const overBudget = !!current?.verified && current.memoryMb !== null && current.memoryMb > this.monitoredBudget(profile.id);
    const mode = savedPolicy.networkMode ?? legacyNetworkMode(profile);
    return { id: profile.id, name: profile.name, engine: profile.engine ?? "chromium", proxy: profile.proxy ? { type: profile.proxy.type, host: profile.proxy.host, port: profile.proxy.port } : null,
      screenWidth: profile.screenWidth, screenHeight: profile.screenHeight, ...policy, resourceSettings: this.resourceSettings(profile.id),
      networkMode: mode, networkSummary: networkSummary(mode, profile.proxy),
      state: this.phases.get(profile.id) ?? (launch ? policy.manual ? "manual" : "running" : "stopped"),
      pid: launch?.pid && launch.pid > 0 ? launch.pid : null, cpuPercent: current?.cpuPercent ?? null,
      memoryMb: current?.memoryMb ?? null, processCount: current?.processCount ?? null, metricsVerified: current?.verified ?? false,
      metricsSampledAt: current?.sampledAt ?? null, overBudget, resourcePolicy: "monitored", ...this.errors.has(profile.id) && { lastError: this.errors.get(profile.id) } };
  }
  private requireProfile(id: string): Profile { assertSafeProfileId(id); const profile = this.options.store.getProfile(id); if (!profile) throw new Error("profile was not found"); return profile; }
  private assertCanStart(): void { this.assertOpen(); if (this.startsClosed) throw new Error("workspace process manager is stopping"); }
  private assertIdentityWritable(): void { if (this.options.readOnlyIdentity) throw new Error("Manage Cloud profile identity in Profiles; Live workspace never writes the private Cloud cache"); }
  private assertOpen(): void { this.options.authorize?.(); if (this.disposed) throw new Error("workspace process manager is closed"); }
  private notify(): void { if (this.disposed) return; const views = this.list(); for (const listener of this.listeners) { try { listener(views); } catch { /* One dashboard cannot prevent native lifecycle updates. */ } } }
  private acquireLaunchSlot(): Promise<void> {
    if (this.launchSlots < this.limit) { this.launchSlots++; return Promise.resolve(); }
    return new Promise((ready) => { this.launchQueue.push(ready); });
  }
  private releaseLaunchSlot(): void { const next = this.launchQueue.shift(); if (next) next(); else this.launchSlots--; }
  /** Close start gates synchronously; existing ownership-aware stops stay usable. */
  beginShutdown(): void {
    this.startsClosed = true; this.monitor.dispose();
    for (const ready of this.launchQueue.splice(0)) ready();
  }
  /** Include starts already inside Launcher.start, before a launch record exists. */
  pendingStartIds(): string[] { return [...this.starts.keys()]; }
  dispose(): void {
    this.beginShutdown(); this.disposed = true; this.listeners.clear();
  }
}
