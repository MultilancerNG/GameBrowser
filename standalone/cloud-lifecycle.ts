/** Optional Cloud composition for the independent GameBrowser application. */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Launcher } from "../launcher.ts";
import { ProfileStore } from "../store.ts";
import { PendingSyncRuntime } from "../pending-sync.ts";
import { CloudBrowserCoordinator, type CloudBrowserProfile } from "../cloud-browser.ts";
import { applySessionToEndpoint, readSessionInSubprocess } from "../session.ts";
import type { LifecycleAdmissionController } from "../lifecycle-admission.ts";
import type { LaunchInfo, Profile } from "../types.ts";
import { StakeModeWorkspace, type StakeModeWorkspaceOptions } from "../workspace/server.ts";
import type { WorkspaceIdentityStore } from "../workspace/processManager.ts";
import { normalizeWorkspacePolicy } from "../workspace/profileStore.ts";
import { normalizeNetworkMode } from "../workspace/networkPolicy.ts";
import { decodePortableProfile } from "../portable-profile.ts";
import { proxyHostPort } from "../proxy.ts";
import type { StandaloneCloudContext } from "./cloud.ts";
import { initializeBoundPendingQueue } from "./queue-service-binding.ts";

export interface StandaloneCloudLifecycleOptions {
  root: string;
  assets: StakeModeWorkspaceOptions["assets"];
  syncExtensionRoot: string;
  admission: LifecycleAdmissionController;
  desktop?: boolean;
  binaryPath?: string;
  binarySha256?: string;
  firefoxBinaryPath?: string;
  firefoxBinarySha256?: string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  appFetch?: StakeModeWorkspaceOptions["appFetch"];
}

/** Local identity and Cloud authority never share a store or a browser owner. */
export class StandaloneCloudLifecycle {
  private context?: StandaloneCloudContext;
  private store?: ProfileStore;
  private launcher?: Launcher;
  private coordinator?: CloudBrowserCoordinator;
  private workspace?: StakeModeWorkspace;
  private queue?: PendingSyncRuntime;
  private roster = new Map<string, CloudBrowserProfile>();
  private refreshedAt = 0;
  private refreshing?: Promise<void>;
  private guard?: ReturnType<typeof setInterval>;
  private stopped = false;
  private quiescing = false;
  private exiting = false;
  private generation = 0;
  private createdKey?: string;
  private verified = new Map<string, { version: number; profile: Profile; sessionBundle?: string }>();

  constructor(private readonly options: StandaloneCloudLifecycleOptions) {}

  takeCreatedQueueKey(): string | undefined {
    const key = this.createdKey;
    this.createdKey = undefined;
    return key;
  }

  listLaunches(): LaunchInfo[] { return this.store?.listLaunches() ?? []; }

  appContext() {
    if (!this.current() || !this.context || !this.store || !this.workspace || !this.coordinator) return undefined;
    return { context: this.context, store: this.store, workspace: this.workspace, coordinator: this.coordinator };
  }

  private current(): boolean {
    return !this.stopped && !this.quiescing && !this.exiting && !!this.context?.current()
      && this.context.auth.hasSession() && !!this.context.connection.accountId();
  }

  private authorized(id?: string): boolean {
    return this.current() && Date.now() - this.refreshedAt < 5000
      && (!id || this.roster.get(id)?.permission === "edit");
  }

  private ownedLaunch(id: string): LaunchInfo | null {
    const launch = this.store?.getLaunch(id);
    const account = this.context?.connection.accountId();
    const open = account && this.queue?.queue()?.getOpen(id, account);
    return launch && open && !open.cleanupMode && open.debugPort === launch.debugPort
      && open.startedAt === launch.startedAt ? launch : null;
  }

  private verifiedProfile(id: string): Profile | null {
    if (!this.authorized(id)) return null;
    if (this.ownedLaunch(id)) return this.store?.getProfile(id) ?? null;
    return this.verified.get(id)?.profile ?? null;
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (!this.current() || !this.coordinator) throw new Error("Sign in to Cloud in Settings before opening its workspace");
    const generation = this.generation;
    const task = (async () => {
      try {
        const result = await this.coordinator!.listRoster();
        if (!this.current() || generation !== this.generation) throw new Error("Cloud account changed");
        // A legacy cache is retained for encrypted close recovery, never accepted
        // as this service/account's identity merely because a profile ID matches.
        const candidates = result.profiles.filter(profile => profile.permission === "edit"
          && this.verified.get(profile.id)?.version !== profile.version);
        for (let offset = 0; offset < candidates.length; offset += 8) {
          await Promise.all(candidates.slice(offset, offset + 8).map(async summary => {
            const response = await this.context!.connection.client.getProfile(summary.id);
            if (!this.current() || generation !== this.generation) throw new Error("Cloud account changed");
            const decoded = decodePortableProfile(response.payload);
            if (decoded.profile.id !== summary.id || response.profile.id !== summary.id || response.profile.version !== summary.version
              || response.profile.permission !== "edit" || response.profile.trashedAt !== null) throw new Error("Cloud profile access changed; refresh its workspace");
            this.verified.set(summary.id, { version: response.profile.version, profile: decoded.profile, sessionBundle: decoded.sessionBundle });
            // Do not replace an active browser's frozen identity or a retained
            // foreign generation while hydrating this account's display data.
            if (!this.store!.getLaunch(summary.id)) this.store!.upsertProfile(decoded.profile);
          }));
        }
        this.roster = new Map(result.profiles.map(summary => {
          const profile = this.ownedLaunch(summary.id) ? this.store!.getProfile(summary.id) : this.verified.get(summary.id)?.profile;
          const owned = this.ownedLaunch(summary.id);
          return [summary.id, { ...summary, proxy: profile?.proxy ? proxyHostPort(profile.proxy) : null, proxyError: profile?.proxyError,
            engine: profile?.engine, chromiumRuntime: profile?.chromiumRuntime,
            running: !!owned, debugPort: owned?.debugPort, startedAt: owned?.startedAt,
            screen: profile ? `${profile.screenWidth}x${profile.screenHeight}` : "1366x768" }];
        }));
        this.refreshedAt = Date.now();
      } catch (error) {
        if (generation === this.generation) { this.roster.clear(); this.refreshedAt = 0; }
        throw error;
      }
    })();
    this.refreshing = task;
    try { await task; } finally { if (this.refreshing === task) this.refreshing = undefined; }
  }

  private async authorize(id?: string): Promise<void> {
    await this.refresh();
    if (!this.authorized(id)) throw new Error("Current Cloud edit access is required");
  }

  private scopedStore(store: ProfileStore): WorkspaceIdentityStore {
    const list = () => this.authorized() ? [...this.roster.keys()].map(id => this.verifiedProfile(id)).filter((profile): profile is Profile => !!profile) : [];
    const write = (): never => { throw new Error("Manage Cloud profile identity through the Cloud service"); };
    return {
      listProfiles: list, getProfile: id => list().find(profile => profile.id === id) ?? null,
      getLaunch: id => this.authorized(id) ? this.ownedLaunch(id) : null,
      listLaunches: () => store.listLaunches().filter(launch => this.authorized(launch.profileId) && this.ownedLaunch(launch.profileId)),
      getSessionBundle: id => this.authorized(id) ? this.verified.get(id)?.sessionBundle ?? null : null,
      getProfileResourcePolicy: id => store.getProfileResourcePolicy(id),
      hasFingerprintSeed: seed => store.hasFingerprintSeed(seed),
      upsertProfiles: write, deleteProfile: write,
      isTrashed: id => !this.authorized(id) || store.isTrashed(id),
    };
  }

  async authenticate(context: StandaloneCloudContext): Promise<void> {
    if (this.stopped || this.quiescing) throw new Error("GameBrowser is stopping");
    if (this.context) throw new Error("Sign out before opening another Cloud account");
    if (!context.current() || !context.auth.state().authenticated || !context.connection.accountId()) throw new Error("Cloud authentication is required");
    const generation = ++this.generation;
    this.context = context;
    this.exiting = false;
    const { root } = this.options;
    const cache = join(root, "cloud-cache");
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    this.queue = new PendingSyncRuntime(join(root, "pending-sync.sqlite"), this.options.desktop ? undefined : join(root, "pending-sync.key"));
    try {
      const initialized = initializeBoundPendingQueue({ runtime: this.queue, root, baseUrl: context.configuration.baseUrl,
        queueKey: context.queueKey || (!this.options.desktop ? this.options.env?.ALIASMODE_QUEUE_ENCRYPTION_KEY : undefined) });
      this.createdKey = initialized.createdKey;
      const store = this.store = new ProfileStore(join(cache, "profiles.sqlite"));
      let workspace: StakeModeWorkspace | undefined;
      const launcher = this.launcher = new Launcher({
        store, dataRoot: join(cache, "profiles"), chromiumRuntimeRoot: join(root, "runtimes"),
        headless: true, windowWidthScale: 1, windowHeightScale: 1, labelWindow: async () => {},
        resetStorageOnUncleanExit: true, ensureCookies: async () => ({ injected: false }),
        log: this.options.log, resourcePolicy: id => store.getProfileResourcePolicy(id),
        binaryPath: this.options.binaryPath, expectedBinarySha256: this.options.binarySha256,
        firefoxBinaryPath: this.options.firefoxBinaryPath, expectedFirefoxBinarySha256: this.options.firefoxBinarySha256,
        profileExtensionDirs: profile => workspace?.extensionDirectories(profile),
        profileFirefoxAddonDirs: profile => workspace?.firefoxAddonDirectories(profile),
        profileFirefoxAddonUUIDs: profile => workspace?.firefoxAddonUUIDs(profile),
        profileNetworkMode: profile => workspace?.manager.getNetworkMode(profile.id),
        profileResourceLimits: profile => profile.engine === "firefox" ? undefined : workspace?.manager.getResourceLimits(profile.id),
      });
      const coordinator = this.coordinator = new CloudBrowserCoordinator({
        cloud: context.connection.client, launcher, store, queue: () => this.queue?.queue(),
        accountId: () => context.current() ? context.connection.accountId() : undefined,
        deviceId: () => context.current() ? context.connection.deviceId() : undefined,
        readSession: (endpoint, captureSeed, options) => readSessionInSubprocess(endpoint, { ...options, captureSeed }),
        applySession: (endpoint, bundle, urls) => applySessionToEndpoint(endpoint, bundle, urls, { log: this.options.log }),
        beforeLaunch: async profile => {
          if (!workspace) throw new Error("Cloud workspace preparation is unavailable");
          await this.authorize(profile.id);
          const verified = this.verified.get(profile.id);
          if (!verified) throw new Error("Cloud profile identity has not been verified");
          // The coordinator just decoded and normalized the authoritative open
          // payload. Preparation must see that exact immutable launch identity.
          this.verified.set(profile.id, { ...verified, profile });
          await workspace.prepareLaunch(profile.id, profile);
        },
        log: this.options.log,
      });
      await launcher.reconcileOrphans();
      await launcher.certifySurvivors();
      const status = await context.connection.client.status();
      if (status.account.id !== context.connection.accountId() || generation !== this.generation || !context.current()) throw new Error("Cloud account changed");
      const legal = status.legal;
      const accepted = !!legal.accepted && legal.accepted.terms === legal.current.terms
        && legal.accepted.privacy === legal.current.privacy && legal.accepted.acceptableUse === legal.current.acceptableUse;
      if (accepted) await coordinator.resumeAfterAuthentication(() => this.current() && generation === this.generation);
      else await coordinator.secureAfterAuthentication(() => this.current() && generation === this.generation);
      await this.refresh();
      const scope = `cloud-${createHash("sha256").update(`${context.configuration.baseUrl}:${context.connection.accountId()}`).digest("hex")}`;
      workspace = this.workspace = new StakeModeWorkspace({
        launcher, store: this.scopedStore(store), stateRoot: join(root, "live-workspace", scope),
        assets: this.options.assets, syncExtensionRoot: this.options.syncExtensionRoot, syncController: "relay",
        authorize: () => this.authorize(), isAuthorized: id => this.authorized(id),
        authorizeLaunch: async id => this.authorized(id) && await launcher.certifiedActive(id) && this.authorized(id),
        appFetch: this.options.appFetch,
        capabilities: { mode: "cloud", identityManagement: true, contextKey: scope,
          manageProfilesUrl: "/workspace/cloud/dashboard.html#settings", settingsUrl: "/workspace/cloud/dashboard.html#settings" },
        managerOptions: {
          readOnlyIdentity: true,
          authorize: () => { if (!this.authorized()) throw new Error("Cloud access changed"); },
          externalProfiles: () => this.authorized() ? [...this.roster.values()].filter(profile => profile.permission === "edit").map(profile => {
            const screen = /^(\d+)\s*[x×]\s*(\d+)$/.exec(profile.screen);
            return { id: profile.id, name: profile.name, engine: profile.engine ?? "chromium",
              screenWidth: screen ? Number(screen[1]) : 1366, screenHeight: screen ? Number(screen[2]) : 768 };
          }) : [],
          beforeStart: id => this.authorize(id),
          lifecycle: {
            start: (id, _options, urls) => this.options.admission.run({ kind: "start", profileIds: [id] }, async () => {
              await this.authorize(id);
              const result = await coordinator.open(id, urls, { headless: true });
              if (!result.ok) throw new Error(result.error || "Cloud browser could not open");
              if (!this.authorized(id)) throw new Error("Cloud access changed while opening the browser");
            }),
            stop: (id, force) => this.options.admission.run({ kind: "stop", profileIds: [id] }, async () => {
              await this.authorize(id);
              if (force) throw new Error("Close a Cloud profile normally so its session can be saved");
              return (await coordinator.close(id)).closed;
            }),
          },
        },
      });
      this.guard = setInterval(() => { void this.refresh().catch(() => {}); }, 1000);
      this.guard.unref?.();
    } catch (error) {
      // A failed authentication must not orphan an owned browser or destroy its queue.
      if (this.coordinator && !await this.coordinator.releaseAll(true)) {
        throw Object.assign(new Error("Cloud browser recovery could not finish; authentication must remain available"), { retainCloudAuthentication: true });
      }
      await this.dispose();
      throw error;
    }
  }

  async resolve(context?: StandaloneCloudContext, relayUrl?: string): Promise<StakeModeWorkspace> {
    if (!context || !this.context || context.generation !== this.context.generation || context.auth !== this.context.auth || !this.workspace) throw new Error("Sign in to Cloud in Settings first");
    await this.authorize();
    if (relayUrl) this.workspace.activate(relayUrl);
    return this.workspace;
  }

  readonly profiles = {
    list: async () => { await this.authorize(); return { profiles: [...this.roster.values()], healthSources: [] as [] }; },
    create: async (profile: Profile, preferences?: { origin?: string; networkMode?: unknown; ramMb?: number; heapMb?: number; explicitHeap?: boolean }) => {
      await this.authorize();
      const origin = preferences?.origin ? new URL(preferences.origin).origin : undefined;
      if (origin && (origin !== preferences?.origin || !this.workspace!.relay.origins.includes(origin))) throw new Error("Choose an approved workspace website");
      const policy = normalizeWorkspacePolicy({
        ...(preferences?.ramMb !== undefined ? { ramMb: preferences.ramMb } : {}),
        ...(preferences?.heapMb !== undefined ? { heapMb: preferences.heapMb, explicitHeap: preferences.explicitHeap ?? true } : {}),
        ...(preferences?.networkMode !== undefined ? { networkMode: normalizeNetworkMode(preferences.networkMode) } : {}),
        urls: origin ? [origin] : [], headless: true,
      });
      const result = await this.coordinator!.create(profile);
      await this.refresh();
      const { ramMb, heapMb, explicitHeap, urls, budgetAction, networkMode } = policy;
      this.workspace!.manager.setDevicePolicy(result.id, { ramMb, heapMb, explicitHeap, urls, budgetAction, ...(networkMode ? { networkMode } : {}) });
      return result;
    },
    open: async (id: string) => { await this.authorize(id); await this.workspace!.manager.start(id); return { ok: true }; },
    close: async (id: string) => { await this.authorize(id); return this.coordinator!.close(id); },
    retryPending: async () => { await this.authorize(); await this.coordinator!.retryPending(); },
  };

  async signingOut(context?: StandaloneCloudContext): Promise<void> {
    if (!this.context) return;
    if (context && context.auth !== this.context.auth) throw new Error("Cloud account changed");
    // Keep credentials and the account fence available until every owned session is captured.
    if (!await this.coordinator!.releaseAll()) throw new Error("Cloud browsers could not be saved and closed; sign-out was cancelled");
    this.exiting = true;
    await this.dispose();
  }

  async quiesce(): Promise<void> {
    this.quiescing = true;
    if (this.guard) clearInterval(this.guard);
    this.guard = undefined;
    await this.workspace?.quiesce();
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    await this.quiesce();
    if (this.coordinator && !await this.coordinator.releaseAll(true)) throw new Error("Cloud browser shutdown could not be confirmed");
    this.stopped = true;
    await this.dispose();
  }

  private async dispose(): Promise<void> {
    if (this.guard) clearInterval(this.guard);
    this.guard = undefined;
    ++this.generation;
    this.roster.clear(); this.refreshedAt = 0;
    await this.workspace?.stop({ closeBrowsers: false, stopSync: false });
    this.workspace = undefined;
    this.coordinator = undefined;
    this.launcher = undefined;
    this.store?.close(); this.store = undefined;
    this.queue?.close(); this.queue = undefined;
    this.context = undefined;
    this.verified.clear();
    this.createdKey = undefined;
  }
}
