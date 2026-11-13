/** Live workspace shares the desktop server, account boundary and certified Launcher. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import type { DashboardServerOptions } from "./web.ts";
import type { CloudBrowserProfile } from "./cloud-browser.ts";
import { resolvePlaywrightRuntime } from "./playwright-runtime.ts";
import { BrowserSyncError, type BrowserSyncLifecycle } from "./browser-sync.ts";
import { uiBrowserSync } from "./ui.ts";
import { isLoopback } from "./workspace/protocol.ts";
import { StakeModeWorkspace, type SocketState, type StakeModeWorkspaceOptions } from "./workspace/server.ts";
import type { WorkspaceIdentityStore } from "./workspace/processManager.ts";

export interface WorkspaceSocketData { workspace: StakeModeWorkspace; state: SocketState }

export class DashboardWorkspace {
  private workspace?: StakeModeWorkspace;
  private sync?: BrowserSyncLifecycle;
  private scope?: string;
  private roster = new Map<string, CloudBrowserProfile>();
  private refreshedAt = 0;
  private refreshing?: Promise<void>;
  private preparing?: Promise<StakeModeWorkspace>;
  private stopped = false;
  private epoch = 0;
  private readonly owned = new Set<string>();
  private readonly runtimeMode: "local" | "cloud" | undefined;
  private readonly guard: ReturnType<typeof setInterval>;

  constructor(private readonly options: DashboardServerOptions, private readonly dependencies: {
    createWorkspace?: (options: StakeModeWorkspaceOptions) => StakeModeWorkspace;
    sync?: BrowserSyncLifecycle;
  } = {}) {
    const mode = options.appConfig?.read().mode;
    this.runtimeMode = mode === "local" || mode === "cloud" ? mode : undefined;
    this.guard = setInterval(() => { void this.pollAccess().catch(() => {}); }, 1000);
    this.guard.unref?.();
    options.launcher.setWorkspaceHooks?.({
      profileExtensionDirs: p => this.owns(p.id) ? this.workspace?.extensionDirectories(p) : undefined,
      profileFirefoxAddonDirs: p => this.owns(p.id) ? this.workspace?.firefoxAddonDirectories(p) : undefined,
      profileFirefoxAddonUUIDs: p => this.owns(p.id) ? this.workspace?.firefoxAddonUUIDs(p) : undefined,
      profileNetworkMode: p => this.owns(p.id) ? this.workspace?.manager.getNetworkMode(p.id) : undefined,
      profileResourceLimits: p => {
        if (!this.owns(p.id) || p.engine === "firefox") return undefined;
        const limits = this.workspace?.manager.getResourceLimits(p.id);
        return limits;
      },
    });
  }
  private async pollAccess(): Promise<void> {
    const workspace = this.workspace;
    if (!workspace) return;
    if (!this.currentScope() || this.scope !== this.currentScope()) { await this.invalidate(); return; }
    if (this.options.cloudBrowser) {
      try { await this.refresh(); }
      catch { if (this.workspace === workspace) await this.invalidate(true); }
    }
  }
  private owns(id: string): boolean { return this.owned.has(id) && this.authorized(id); }
  private currentScope(): string | undefined {
    const config = this.options.appConfig?.read();
    if (this.stopped || this.options.remote || this.runtimeMode && config?.mode !== this.runtimeMode) return undefined;
    if (config && config.mode !== "local" && config.mode !== "cloud") return undefined;
    const cloud = config?.mode === "cloud" || this.runtimeMode === "cloud" || !!this.options.cloudBrowser;
    if (!cloud) return "local";
    const account = this.options.cloudConnection?.accountId();
    if (!account || !this.options.cloudAuth?.state().authenticated || !this.options.cloudBrowser) return undefined;
    return `cloud-${createHash("sha256").update(`${config?.cloudUrl ?? this.options.defaultCloudUrl ?? ""}:${account}`).digest("hex")}`;
  }
  private authorized(id?: string): boolean {
    if (!this.scope || this.scope !== this.currentScope()) return false;
    if (this.scope === "local") return !id || !!this.options.store.getProfile(id);
    return Date.now() - this.refreshedAt < 5000 && (!id || this.roster.get(id)?.permission === "edit");
  }
  private async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const scope = this.currentScope();
    if (!scope || scope !== this.scope) throw new Error("Choose a mode and sign in before opening Live workspace");
    if (scope === "local") return;
    const task = (async () => {
      try {
        const result = await this.options.cloudBrowser!.listRoster();
        if (scope !== this.currentScope() || scope !== this.scope) throw new Error("Account changed");
        this.roster = new Map(result.profiles.map(p => [p.id, p])); this.refreshedAt = Date.now();
        const plan = this.sync?.status();
        if (plan?.adminId && (plan.active || plan.starting || plan.waiting)
          && [plan.adminId, ...plan.followerIds].some(id => this.roster.get(id)?.permission !== "edit")) {
          await this.sync?.suspend?.("Browser following paused because profile edit access changed; Resume after access is restored");
        }
      } catch (error) { this.roster.clear(); this.refreshedAt = 0; throw error; }
    })();
    this.refreshing = task;
    try { await task; } finally { if (this.refreshing === task) this.refreshing = undefined; }
  }
  private scopedStore(): WorkspaceIdentityStore {
    const store = this.options.store, cloud = this.scope !== "local", scope = this.scope, epoch = this.epoch;
    const list = () => epoch === this.epoch && scope === this.scope && this.scope === this.currentScope() ? cloud
      ? store.listProfiles().filter(p => this.roster.get(p.id)?.permission === "edit") : store.listProfiles() : [];
    const get = (id: string) => list().find(p => p.id === id) ?? null;
    const write = () => {
      if (epoch !== this.epoch || scope !== this.scope || !this.authorized() || cloud) throw new Error("Manage Cloud profile identity in Profiles");
    };
    return {
      listProfiles: list, getProfile: get,
      getLaunch: id => epoch === this.epoch && scope === this.scope && this.authorized(id) ? store.getLaunch(id) : null,
      listLaunches: () => epoch === this.epoch && scope === this.scope ? store.listLaunches().filter(p => this.authorized(p.profileId)) : [],
      getProfileResourcePolicy: id => store.getProfileResourcePolicy(id),
      hasFingerprintSeed: seed => store.hasFingerprintSeed(seed),
      getSessionBundle: id => get(id) ? store.getSessionBundle(id) : null,
      upsertProfiles: profiles => { write(); return store.upsertProfiles(profiles); },
      deleteProfile: id => { write(); return store.deleteProfile(id); },
      isTrashed: id => store.isTrashed(id),
    };
  }
  private runLifecycle<T>(id: string, kind: "start" | "stop", work: () => Promise<T>): Promise<T> {
    return this.options.lifecycleAdmission?.run({ kind, profileIds: [id] }, work) ?? work();
  }
  private async prepare(origin: string): Promise<StakeModeWorkspace> {
    if (this.preparing) return this.preparing;
    const task = (async () => {
      const scope = this.currentScope();
      if (!scope) throw new Error("Choose Local or sign in to Cloud in Profiles before opening Live workspace");
      if (this.workspace && this.scope === scope) { await this.refresh(); return this.workspace; }
      await this.invalidate(); this.scope = scope; await this.refresh();
      const epoch = this.epoch;
      const authorized = (id?: string) => epoch === this.epoch && this.scope === scope && this.authorized(id);
      const authorize = async () => { if (!authorized()) throw new Error("Workspace account changed"); await this.refresh(); if (!authorized()) throw new Error("Workspace account changed"); };
      const runtime = resolvePlaywrightRuntime();
      const source = runtime.kind === "packaged" ? join(runtime.root, "stakemode", "workspace") : join(import.meta.dir, "workspace");
      const assets: Record<string, {body: string | Uint8Array<ArrayBuffer>; contentType: string}> = Object.fromEntries([['html','text/html; charset=utf-8'], ['js','text/javascript; charset=utf-8'], ['css','text/css; charset=utf-8']].map(([ext, contentType]) => [`/workspace/dashboard.${ext}`, { body: readFileSync(join(source, `dashboard.${ext}`), "utf8"), contentType: contentType! }]));
      assets["/workspace/fonts/inter-latin.woff2"] = { body: Uint8Array.from(readFileSync(join(source, "fonts", "inter-latin.woff2"))), contentType: "font/woff2" };
      const cloud = scope !== "local";
      const sharedSync = this.dependencies.sync ?? uiBrowserSync(this.options.launcher, this.options.store, { ...this.options, runtimeMode: this.runtimeMode });
      const checkSync = () => { if (!authorized()) throw new BrowserSyncError("Workspace account or profile access changed", 403); };
      const scopedSync: BrowserSyncLifecycle = {
        status: () => { checkSync(); return sharedSync.status(); },
        start: (...args) => { checkSync(); return sharedSync.start(...args); },
        stop: () => { checkSync(); return sharedSync.stop(); },
        resume: () => { checkSync(); return sharedSync.resume(); },
        save: (...args) => { checkSync(); return sharedSync.save(...args); },
        configurePolicy: (...args) => { checkSync(); return sharedSync.configurePolicy?.(...args) ?? Promise.resolve(sharedSync.status()); },
        currentPolicy: () => { checkSync(); return sharedSync.currentPolicy?.(); },
      };
      const workspace = (this.dependencies.createWorkspace ?? (options => new StakeModeWorkspace(options)))({
        launcher: this.options.launcher, store: this.scopedStore(),
        stateRoot: join(this.options.paths?.root ?? process.cwd(), "live-workspace", scope), assets,
        syncExtensionRoot: runtime.kind === "packaged" ? join(runtime.root, "stakemode", "extensions", "stakemode-sync") : join(import.meta.dir, "extensions", "stakemode-sync"),
        authorize, isAuthorized: authorized,
        authorizeLaunch: async id => authorized(id) && await this.options.launcher.certifiedActive(id) && authorized(id),
        sync: scopedSync,
        capabilities: { mode: cloud ? "cloud" : "local", identityManagement: !cloud, contextKey: scope, manageProfilesUrl: "/?view=profiles", settingsUrl: "/?view=settings&tab=team" },
        managerOptions: {
          readOnlyIdentity: cloud,
          ...(cloud ? { externalProfiles: () => authorized() ? [...this.roster.values()].filter(row => row.permission === "edit").map(row => {
            const screen = /^(\d+)\s*[x×]\s*(\d+)$/.exec(row.screen);
            return { id: row.id, name: row.name, engine: row.engine ?? "chromium" as const,
              screenWidth: screen ? Number(screen[1]) : 1366, screenHeight: screen ? Number(screen[2]) : 768 };
          }) : [] } : {}),
          authorize: () => { if (!authorized()) throw new Error("Workspace account access changed"); },
          beforeStart: authorize,
          lifecycle: {
            start: (id, options, urls) => this.runLifecycle(id, "start", async () => {
              await authorize(); if (!authorized(id)) throw new Error("Edit access is required");
              this.owned.add(id);
              if (cloud) {
                const result = await this.options.cloudBrowser!.open(id, [], { headless: true });
                if (!result.ok) throw new Error("Cloud browser could not open; review its status in Profiles");
              } else await this.options.launcher.start(id, urls, options);
              if (!authorized(id)) throw new Error("Workspace account access changed");
            }),
            stop: (id, force) => this.runLifecycle(id, "stop", async () => {
              await authorize(); if (!authorized(id)) throw new Error("Edit access is required");
              if (cloud) {
                if (force) throw new Error("Close the Cloud browser to save its session; force kill is unavailable");
                return (await this.options.cloudBrowser!.close(id)).closed;
              }
              const launch = this.options.store.getLaunch(id), expected = launch ? { startedAt: launch.startedAt, debugPort: launch.debugPort } : undefined;
              if (!force) await this.options.launcher.captureLocalSession(id);
              return force ? this.options.launcher.forceStop(id, expected) : this.options.launcher.stop(id, expected);
            }),
          },
        },
      });
      this.workspace = workspace; this.sync = sharedSync;
      workspace.activate(`${origin.replace(/^http/, "ws")}/workspace/relay`);
      return workspace;
    })();
    this.preparing = task;
    try { return await task; } finally { if (this.preparing === task) this.preparing = undefined; }
  }
  async handle(request: Request, address: string): Promise<Response> {
    if (!isLoopback(address)) return Response.json({ error: "Loopback workspace access only" }, { status: 403 });
    try { return await (await this.prepare(new URL(request.url).origin)).handleRequest(request, address); }
    catch { return Response.json({ error: "Open Profiles to choose Local or sign in to Cloud, then reopen Live workspace", manageProfilesUrl: "/?view=profiles" }, { status: 401, headers: { "cache-control": "no-store" } }); }
  }
  async upgrade(request: Request, address: string, upgrade: (data: WorkspaceSocketData) => boolean): Promise<Response | undefined> {
    try {
      const workspace = await this.prepare(new URL(request.url).origin);
      return workspace.upgradeRequest(request, address, state => upgrade({ workspace, state }));
    } catch { return Response.json({ error: "Workspace authentication required" }, { status: 401 }); }
  }
  private async invalidate(preservePlan = false): Promise<void> {
    const workspace = this.workspace, sync = this.sync; this.sync = undefined; ++this.epoch; this.workspace = undefined; this.scope = undefined;
    this.roster.clear(); this.refreshedAt = 0; this.owned.clear();
    if (sync) {
      if (preservePlan && sync.suspend) await sync.suspend("Browser following paused while Cloud access is unavailable; Resume after access is verified");
      else await sync.stop();
    }
    await workspace?.stop({ closeBrowsers: false, stopSync: false });
  }
  async stop(): Promise<void> { this.stopped = true; clearInterval(this.guard); await this.invalidate(); }
}

const socketViews = new WeakMap<object, ServerWebSocket<SocketState>>();
export function workspaceSocket(socket: ServerWebSocket<WorkspaceSocketData>): ServerWebSocket<SocketState> {
  const previous = socketViews.get(socket); if (previous) return previous;
  const view = new Proxy(socket, { get(target, key) { return key === "data" ? target.data.state : typeof Reflect.get(target, key) === "function" ? Reflect.get(target, key).bind(target) : Reflect.get(target, key); } }) as unknown as ServerWebSocket<SocketState>;
  socketViews.set(socket, view); return view;
}
