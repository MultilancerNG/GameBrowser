import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Server, ServerWebSocket } from "bun";
import type { Launcher } from "../launcher.ts";
import type { ProfileStore } from "../store.ts";
import type { Profile } from "../types.ts";
import { ALIASMODE_VERSION } from "../version.ts";
import { RelayBrowserFollowing } from "./browserFollowing.ts";
import { RelaySessionController } from "./sessionController.ts";
import type { BrowserSyncLifecycle } from "../browser-sync.ts";
import { assertSafeProfileId } from "../profile-id.ts";
import { BrowserBridge } from "./browserBridge.ts";
import { ProcessManager, type BulkProfileInput, type WorkspaceProfileView, type ProcessManagerOptions, type WorkspaceIdentityStore } from "./processManager.ts";
import { SyncRelay, type RelayTransport } from "./syncRelay.ts";
import { approvedOrigin, browserCommand, browsingUrl, boundedJson, isLoopback, MAX_PACKET_BYTES, MAX_VISIBLE_PROFILES, safeManualControl, sameToken, sessionToken, trustedLocalRequest, WORKSPACE_PORT, type LiveFrame, type ManualControl, type SyncRole } from "./protocol.ts";
import { generateSyncExtension, removeSyncExtension } from "../extensions/stakemode-sync/syncExtension.ts";
import { ExtensionManager, type PreparedExtensionLaunch } from "./extensionManager.ts";
import { ProfileLibrary } from "./profileLibrary.ts";
import { ManagementRoutes } from "./managementRoutes.ts";
import { WorkspaceWorkflowEngine } from "./workflowEngine.ts";
import { WorkflowRoutes } from "./workflowRoutes.ts";
import { ProxyLibrary } from "./proxyLibrary.ts";
import { handleProxyRoute } from "./proxyRoutes.ts";
import { windowsProcessScheduler } from "./windowsProcessScheduler.ts";

export interface SocketState {
  client?: "dashboard" | "profile";
  profileId?: string;
  transport?: RelayTransport;
  subscribed: Set<string>;
  focused?: string;
  authenticationTimer?: ReturnType<typeof setTimeout>;
  windowAt: number;
  windowPackets: number;
}
export interface StakeModeWorkspaceOptions {
  launcher: Launcher;
  store: WorkspaceIdentityStore;
  stateRoot: string;
  port?: number;
  syncExtensionRoot?: string;
  managerOptions?: Partial<ProcessManagerOptions>;
  /** Refreshed before every HTTP/socket action; synchronous guard fences frame delivery. */
  authorize?: () => Promise<void>;
  isAuthorized?: (profileId?: string) => boolean;
  authorizeLaunch?: (profileId: string) => Promise<boolean>;
  sync?: BrowserSyncLifecycle;
  /** Standalone ownership: use the authenticated original relay for either engine. */
  syncController?: "relay";
  /** Called only after workspace same-origin and dashboard-token authentication. */
  appFetch?: (request: Request, remoteAddress: string) => Response | undefined | Promise<Response | undefined>;
  capabilities?: { mode: "local" | "cloud"; identityManagement: boolean; contextKey?: string; manageProfilesUrl: string; settingsUrl: string };

  assets?: Record<string, { body: string | Uint8Array<ArrayBuffer>; contentType: string }>;
  extraFetch?: (request: Request, remoteAddress: string) => Response | undefined | Promise<Response | undefined>;
  /** Tests may inject an ownership-compatible manager and browser transport. */
  manager?: ProcessManager;
  onProfileDeleted?: (profileId: string) => Promise<void> | void;
  bridgeFactory?: (options: ConstructorParameters<typeof BrowserBridge>[0]) => BrowserBridge;
}
export class StakeModeWorkspace {
  readonly manager: ProcessManager;
  readonly relay: SyncRelay;
  readonly bridge: BrowserBridge;
  readonly extensions: ExtensionManager;
  readonly library: ProfileLibrary;
  readonly workflows: WorkspaceWorkflowEngine;
  readonly proxies: ProxyLibrary;
  private browserFollowing?: RelayBrowserFollowing;
  private readonly sync?: BrowserSyncLifecycle;
  private quiescing?: Promise<void>;
  private workflowRoutes: WorkflowRoutes;
  private management: ManagementRoutes;
  private server?: Server<SocketState>;
  private sockets = new Set<ServerWebSocket<SocketState>>();
  private dashboardTokens = new Map<string, number>();
  private dashboardOrigins = new Set<string>();
  private extensionDirs = new Map<string, string>();
  private preparedExtensions = new Map<string, PreparedExtensionLaunch>();
  private unsubscribe: () => void;
  private settingsFile: string;
  private snapshotTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private shutdown = false;
  private changingManual = false;
  private activated = false;
  private relayUrl = "ws://127.0.0.1:8080/relay";
  private draftGroup?: { adminId: string | null; followerIds: string[] };
  private cleanedProfiles = new Set<string>();
  private followingAttachments = new Map<string, Promise<void>>();
  private controlQueues = new Map<string, { count: number; chain: Promise<void> }>();
  constructor(private options: StakeModeWorkspaceOptions) {
    if (options.sync && options.syncController) throw new Error("Choose one browser following controller");
    mkdirSync(join(options.stateRoot, "workspace"), { recursive: true, mode: 0o700 });
    this.settingsFile = join(options.stateRoot, "workspace", "settings.json");
    this.relay = new SyncRelay({ controller: options.sync ? "worker" : "extension", preserveAssignments: options.syncController === "relay", isAuthorized: id => this.authorized(id), onChange: () => this.publishSnapshot(), onAction: (id, action) => this.browserFollowing?.noteAction(id, action), onManual: (id, reason) => {
      if (!this.changingManual && this.sync && reason === "operator_manual") {
        void this.changeRole(id, "manual").catch(() => {});
      }
      if (!this.changingManual && this.manager?.getProfile(id)) {
        this.changingManual = true;
        try { this.manager.setManual(id, true); } finally { this.changingManual = false; }
      }
    } });
    if (existsSync(this.settingsFile)) {
      const raw = readFileSync(this.settingsFile, "utf8");
      if (raw.length > 65536) throw new Error("Workspace settings exceed their limit");
      const settings = JSON.parse(raw);
      if (settings.version !== 1 || !Array.isArray(settings.origins)) throw new Error("Workspace settings are invalid");
      this.relay.configure(settings.origins, settings.pacing);
    } else this.relay.configure(["https://stake.com", "https://bc.game"], "fast");
    this.manager = options.manager ?? new ProcessManager({ ...options.managerOptions, launcher: options.launcher, store: options.store, stateRoot: options.stateRoot,
      beforeStart: async (id, profile) => { await options.managerOptions?.beforeStart?.(id, profile); await this.prepareProfile(id, profile); }, afterDelete: id => this.cleanupProfile(id) });
    this.library = new ProfileLibrary(options.stateRoot, id => !!this.manager.getProfile(id));
    this.proxies = new ProxyLibrary(options.stateRoot);
    this.extensions = new ExtensionManager({ stateRoot: options.stateRoot,
      isProfileStopped: id => this.manager.canEditProfile(id), getProfileEngine: id => this.manager.getProfile(id)?.engine });
    this.registerProfiles(this.manager.list());
    this.sync = options.sync ?? (options.syncController === "relay" ? new RelaySessionController({
      stateRoot: options.stateRoot, relay: this.relay, profileExists: id => !!this.manager.getProfile(id),
      hasLaunch: id => !!this.manager.getLaunch(id), isAuthorized: id => this.authorized(id),
      setManual: (id, enabled) => { this.manager.setManual(id, enabled); }, changed: () => { this.reconcileFollowingConnections(); this.publishSnapshot(); },
    }) : undefined);
    this.bridge = (options.bridgeFactory ?? (config => new BrowserBridge(config)))({
      controller: options.sync ? "worker" : "extension",
      ...(options.syncController ? { captureFallback: { connected: (id: string) => this.relay.statuses().some(row => row.profileId === id && row.connected) } } : {}),
      authorizeLaunch: options.authorizeLaunch,
      getLaunch: id => this.authorized(id) ? this.manager.getLaunch(id) : null,
      getConfig: id => this.relay.configFor(id),
      getViewport: id => { const profile = this.manager.getProfile(id); return this.options.launcher.desktopViewport?.(id) ?? (profile ? { width: profile.screenWidth, height: profile.screenHeight } : undefined); },
      canControl: id => this.canControl(id),
      onFrame: frame => this.publishFrame(frame),
      onError: (profileId, error) => this.publishProfilePacket(profileId, { type: "FRAME_ERROR", profileId, error }),
      onFirefoxConnect: (id, token, transport) => this.relay.authenticate(id, token, transport),
      onFirefoxPacket: (id, transport, packet) => this.relay.receive(id, transport, packet),
      onDisconnect: (id, transport) => { this.browserFollowing?.disconnected(id); this.relay.disconnect(id, transport); },
      beforeBrowserAction: id => { if (!this.sync) this.relay.manual(id, "operator_navigation"); },
      onNavigation: (id, value) => {
        if (this.sync && !options.syncController || options.syncController && value === "about:blank") return;
        const interrupt = () => options.syncController ? this.relay.interrupt(id, "manual_navigation") : this.relay.manual(id, "manual_navigation");
        try {
          const url = new URL(value), config = this.relay.configFor(id);
          if (!config?.origins.includes(url.origin) || url.search || url.hash || url.username || url.password) interrupt();
        } catch { interrupt(); }
      },
      onBrowserState: browser => { this.browserFollowing?.observe(browser); this.publishProfilePacket(browser.profileId, { type: "BROWSER_STATE", browser }); },
      onOperatorBrowserAction: (_id, command, browser) => this.browserFollowing?.observe(browser, command),
      contentScriptPath: join(options.syncExtensionRoot ?? process.env.STAKEMODE_SYNC_EXTENSION_ROOT ?? join(import.meta.dir, "..", "extensions", "stakemode-sync"), "content.js"),
    });
    if (options.syncController === "relay") this.browserFollowing = new RelayBrowserFollowing({
      session: () => this.sync!.status(), generation: () => (this.sync as RelaySessionController).generation,
      stamp: id => this.relay.configFor(id)?.epoch ?? -1,
      origins: () => this.relay.origins, pacing: () => this.relay.pacing,
      ready: id => { const status = this.relay.statuses().find(row => row.profileId === id); return this.authorized(id) && !!this.manager.getLaunch(id) && !!status?.connected && !status.paused && status.role !== "manual"; },
      apply: (id, key, event, current) => this.bridge.applyFollowedBrowserState(id, key, event, current),
      pause: id => this.relay.interrupt(id, "browser_following_failed"),
    });
    this.management = new ManagementRoutes({ manager: this.manager, bridge: this.bridge, relay: this.relay, extensions: this.extensions, library: this.library,
      onRoleChange: this.sync ? (id, role) => this.changeRole(id, role) : undefined,
      onPauseChange: this.sync ? (id, enabled) => this.changePause(id, enabled) : undefined,
      snapshot: () => this.snapshot(), changed: () => this.publishSnapshot(), openExtensionPage: (id, extensionId, kind) => this.openExtensionPage(id, extensionId, kind) });
    this.workflows = new WorkspaceWorkflowEngine({ stateRoot: options.stateRoot,
      execute: (id, step, signal) => this.bridge.executeWorkflowStep(id, step, signal),
      canRunProfile: id => {
        const profile = this.manager.getProfile(id);
        return !!profile && !!this.manager.getLaunch(id) && profile.manual === true && this.relay.configFor(id)?.role === "manual" && (!profile.overBudget || profile.budgetAction === "notify");
      },
      onChange: () => this.publishSnapshot() });
    this.workflowRoutes = new WorkflowRoutes(this.workflows, this.manager);
    this.unsubscribe = this.manager.onChange(profiles => {
      this.registerProfiles(profiles);
      for (const profile of profiles) {
        const status = this.relay.statuses().find(row => row.profileId === profile.id);
        if (profile.overBudget && profile.budgetAction !== "notify" && !status?.paused) {
          if (this.sync) void this.changePause(profile.id, true).catch(() => {});
          else if (status?.role !== "manual") this.relay.manual(profile.id, "resource_budget");
        }
        if (profile.state === "stopped") { this.bridge?.detach(profile.id); if (status?.connected) this.relay.disconnect(profile.id); }
      }
      this.reconcileFollowingConnections(); this.publishSnapshot();
    });
  }
  /** Publish external identity/import/Trash changes through the same workspace. */
  refreshProfiles(): void { this.registerProfiles(this.manager.list()); this.refreshVisible(); this.publishSnapshot(); }
  /** Used only after the identity store has confirmed permanent local deletion. */
  async forgetProfile(id: string): Promise<void> {
    assertSafeProfileId(id);
    if (this.manager.getProfile(id) || this.manager.getLaunch(id)) throw new Error("Profile deletion must be confirmed before workspace cleanup");
    await this.cleanupProfile(id); this.refreshProfiles();
  }
  private reconcileFollowingConnections(): void {
    if (this.shutdown || !this.options.syncController || !this.bridge) return;
    const session = this.sync?.status();
    if (!session?.adminId) return;
    for (const id of [session.adminId, ...session.followerIds]) {
      if (!this.authorized(id) || !this.manager.getLaunch(id) || this.followingAttachments.has(id)) continue;
      const pending = this.bridge.attach(id).then(() => { if (!this.shutdown && session.adminId === id) this.browserFollowing?.seed(id); }).catch(() => {}).finally(() => this.followingAttachments.delete(id));
      this.followingAttachments.set(id, pending);
    }
  }
  private registerProfiles(profiles: WorkspaceProfileView[]): void {
    for (const p of profiles) {
      if (this.relay.configFor(p.id)) continue;
      const origin = p.urls.length ? new URL(p.urls[0]!).origin : undefined;
      this.relay.register(p.id, origin && this.relay.origins.includes(origin) ? origin : undefined);
    }
  }
  /** Cloud payloads must be materialized and authorized before launch hooks
   * read their device-only synchronizer/add-on directories. */
  async prepareLaunch(id: string, profile: Profile): Promise<void> {
    assertSafeProfileId(id);
    await this.options.authorize?.();
    const cached = this.options.store.getProfile(id);
    if (!this.authorized(id) || profile.id !== id || !cached || !isDeepStrictEqual(cached, profile)) throw new Error("Profile launch identity or access changed");
    await this.prepareProfile(id, cached);
    await this.options.authorize?.();
    if (!this.authorized(id) || !isDeepStrictEqual(this.options.store.getProfile(id), cached)) throw new Error("Profile launch identity or access changed during preparation");
  }
  private async prepareProfile(id: string, _profile: Profile): Promise<void> {
    // Starting an already running profile is idempotent. Never rewrite code or
    // credentials loaded by its current browser generation.
    if (this.manager.getLaunch(id)) return;
    const dto = this.manager.getProfile(id);
    if (!dto) throw new Error("Workspace profile is missing");
    for (const url of dto.urls) browsingUrl(url);
    this.relay.register(id);
    const origin = dto.urls[0] ? new URL(dto.urls[0]).origin : undefined;
    if (origin && this.relay.origins.includes(origin)) this.relay.setOrigin(id, origin);
    else if (this.options.syncController) this.relay.interrupt(id, "manual_startup");
    else this.relay.manual(id, "manual_startup");
    const config = this.relay.configFor(id)!;
    this.extensionDirs.set(id, await generateSyncExtension({ stateRoot: this.options.stateRoot, profileId: id, config, sourceDirectory: this.options.syncExtensionRoot }));
    this.preparedExtensions.set(id, await this.extensions.prepareLaunch(id, dto.engine));
  }
  extensionDirectories(profile: Profile): string[] {
    if (profile.engine === "firefox") return [];
    const directory = this.extensionDirs.get(profile.id);
    return [...directory ? [directory] : [], ...this.preparedExtensions.get(profile.id)?.chromiumDirectories ?? []];
  }
  firefoxAddonDirectories(profile: Profile): string[] { return this.preparedExtensions.get(profile.id)?.firefoxDirectories ?? []; }
  firefoxAddonUUIDs(profile: Profile): Record<string, string> { return { ...this.preparedExtensions.get(profile.id)?.firefoxAddonUUIDs ?? {} }; }
  private async openExtensionPage(id: string, extensionId: string, kind: "popup" | "options"): Promise<object> {
    if (!this.canControl(id)) throw new Error("Start the profile and switch it to manual control before opening an add-on");
    const entry = this.preparedExtensions.get(id)?.entries.find(row => row.id === extensionId);
    const assignment = this.extensions.listAssignments(id).find(row => row.extensionId === extensionId && row.enabled);
    if (!entry?.browserOrigin || !assignment || !entry.ui[kind]) throw new Error("The enabled add-on does not provide this page in the current browser generation");
    return this.bridge.openExtensionPage(id, { origin: entry.browserOrigin, entrypoint: entry.ui[kind]! });
  }
  private authorized(profileId?: string): boolean {
    try { return !this.shutdown && (this.options.isAuthorized?.(profileId) ?? true); } catch { return false; }
  }
  snapshot(): object {
    if (!this.authorized()) return { profiles: [], groups: [], origins: [], error: "Workspace access changed; reconnect from Profiles" };
    const session = this.sync?.status();
    const profiles = this.manager.list().filter(profile => this.authorized(profile.id));
    this.registerProfiles(profiles);
    if (session && !this.options.syncController && (!this.draftGroup || session.adminId)) {
      const ids = new Set(profiles.map(profile => profile.id));
      const adminId = session.adminId && ids.has(session.adminId) ? session.adminId : null;
      this.relay.setGroup(adminId, adminId ? session.followerIds.filter(id => ids.has(id)) : []);
    }
    const statuses = new Map(this.relay.statuses().map(row => [row.profileId, row]));
    return { version: ALIASMODE_VERSION, capabilities: this.options.capabilities, syncSession: session, profiles: profiles.map(p => { const metadata = this.library.get(p.id); return { ...p, ...(statuses.get(p.id) ?? { role: "manual", paused: false, connected: false, origin: "", queued: 0 }),
      ...(session && !this.options.syncController ? { connected: session.active && (session.adminId === p.id || session.followerIds.includes(p.id)) && !!this.manager.getLaunch(p.id),
        paused: this.relay.explicitlyPausedProfileIds().includes(p.id) || ((session.adminId === p.id || session.followerIds.includes(p.id)) && !session.active) } : {}),
      groupId: metadata.groupId, tags: metadata.tags, notes: metadata.notes, bookmarkCount: metadata.bookmarks.length,
      managementAvailable: this.options.capabilities?.identityManagement ?? true, syncMechanism: this.sync && !this.options.syncController ? "Trusted browser worker" : p.engine === "firefox" ? "Playwright page binding" : this.options.syncController ? "Manifest V3 extension / authenticated page binding" : "Manifest V3 extension" }; }), groups: this.library.listGroups(),
      pacing: this.relay.pacing, origins: this.relay.origins, epoch: this.relay.epoch,
      limits: { maxVisible: MAX_VISIBLE_PROFILES, maxProfiles: 256, maxConcurrentLaunches: 4, screenshotFps: 2 },
      policy: { credentialsMirrored: this.sync && !this.options.syncController ? this.sync.currentPolicy?.()?.sensitiveControls !== "manual" : false, financialActionsMirrored: this.sync && !this.options.syncController ? this.sync.currentPolicy?.()?.sensitiveControls !== "manual" : false, actionsRequireHumanOperator: true } };
  }
  async configureSyncPolicy(reconnect = true): Promise<void> {
    await this.sync?.configurePolicy?.({ origins: this.relay.origins, pacing: this.relay.pacing, sensitiveControls: "manual",
      pausedProfileIds: this.relay.explicitlyPausedProfileIds() }, reconnect);
  }
  private async changePause(id: string, enabled: boolean): Promise<void> {
    if (!this.authorized(id) || !this.manager.getProfile(id)) throw new Error("Profile access changed");
    this.relay.setPaused(id, enabled);
    await this.configureSyncPolicy(); this.publishSnapshot();
  }
  private async changeRole(id: string, role: SyncRole): Promise<void> {
    if (!this.authorized(id) || !this.manager.getProfile(id)) throw new Error("Profile access changed");
    const runtime = this.sync;
    if (!runtime) { this.relay.setRole(id, role); return; }
    const current = runtime.status();
    const configured = current.adminId ? current : this.draftGroup ?? current;
    if (!current.adminId) {
      let adminId = configured.adminId;
      const followerIds = configured.followerIds.filter(candidate => candidate !== id);
      if (role === "admin") {
        if (adminId && adminId !== id) followerIds.unshift(adminId);
        adminId = id;
      } else if (role === "follower") followerIds.push(id);
      else if (adminId === id) adminId = null;
      if (!adminId || !followerIds.length) {
        this.draftGroup = { adminId, followerIds };
        this.changingManual = true;
        try { this.manager.setManual(id, role === "manual"); this.relay.setRole(id, role); } finally { this.changingManual = false; }
        this.publishSnapshot(); return;
      }
      await this.configureSyncPolicy(false); await runtime.start(adminId, followerIds, false);
      this.draftGroup = undefined; this.publishSnapshot(); return;
    }
    if (role === "manual") {
      const followers = current.followerIds.filter(candidate => candidate !== id);
      if (current.adminId === id || !followers.length) await runtime.stop();
      else if (current.adminId && followers.length !== current.followerIds.length) {
        await this.configureSyncPolicy(false); await runtime.start(current.adminId, followers, current.saved);
      }
    } else {
      const adminId = role === "admin" ? id : current.adminId;
      const followers = current.followerIds.filter(candidate => candidate !== id && candidate !== adminId);
      if (role === "follower") followers.push(id);
      if (role === "admin" && current.adminId && current.adminId !== id) followers.unshift(current.adminId);
      if (!adminId || !followers.length) throw new Error("Select one Admin and at least one follower, then Apply selection in Browser following");
      await this.configureSyncPolicy(false); await runtime.start(adminId, followers, current.saved);
    }
    this.publishSnapshot();
  }
  /** Mount on the current dashboard; no additional fixed-port listener. */
  activate(relayUrl: string): void {
    this.relayUrl = relayUrl;
    this.relay.setRelayUrl(relayUrl);
    if (this.activated) return;
    this.activated = true; this.shutdown = false;
    this.bridge.start(); this.workflows.start();
    this.heartbeat = setInterval(() => {
      for (const socket of this.sockets) if (socket.data.client) {
        if (!this.authorized(socket.data.profileId)) socket.close(4001, "Workspace access changed");
        else this.send(socket, { type: "PING", at: Date.now() });
      }
      this.publishSnapshot();
    }, 1000);
    this.heartbeat.unref?.();
  }
  async upgradeRequest(request: Request, address: string, upgrade: (data: SocketState) => boolean): Promise<Response | undefined> {
    try { await this.options.authorize?.(); } catch { return json({ error: "Workspace access could not be verified" }, 401); }
    const url = new URL(request.url), origin = request.headers.get("origin"), host = request.headers.get("host");
    const acceptedOrigin = !origin || origin === url.origin || this.dashboardOrigins.has(origin) || /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
    if (!this.authorized() || !isLoopback(address) || host !== url.host || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !acceptedOrigin || url.search || this.sockets.size >= 272) return json({ error: "WebSocket origin or connection is not permitted" }, 403);
    if (upgrade({ subscribed: new Set(), windowAt: Date.now(), windowPackets: 0 })) return undefined;
    return json({ error: "WebSocket upgrade required" }, 426);
  }
  readonly socketHandlers = {
    open: (socket: ServerWebSocket<SocketState>): void => {
      this.sockets.add(socket);
      socket.data.authenticationTimer = setTimeout(() => socket.close(4001, "Authentication required"), 5000);
    },
    message: (socket: ServerWebSocket<SocketState>, value: string | Buffer): void => {
      void this.socketMessage(socket, value).catch(() => socket.close(4001, "Workspace access changed or invalid message"));
    },
    close: (socket: ServerWebSocket<SocketState>): void => {
      clearTimeout(socket.data.authenticationTimer); this.sockets.delete(socket);
      socket.data.focused = undefined; socket.data.subscribed.clear();
      if (socket.data.profileId) (this.browserFollowing?.disconnected(socket.data.profileId), this.relay.disconnect(socket.data.profileId, socket.data.transport));
      this.refreshVisible();
    },
  };
  get port(): number | undefined { return this.server?.port; }
  async start(): Promise<number> {
    if (this.server) return this.server.port!;
    this.server = Bun.serve<SocketState>({ hostname: "127.0.0.1", port: this.options.port ?? 0,
      maxRequestBodySize: 1048576,
      fetch: async (request, server) => {
        const address = server.requestIP(request)?.address ?? "";
        if (["/relay", "/workspace/relay"].includes(new URL(request.url).pathname)) return this.upgradeRequest(request, address, data => server.upgrade(request, { data }));
        return this.handleRequest(request, address);
      },
      websocket: { maxPayloadLength: MAX_PACKET_BYTES, idleTimeout: 120, backpressureLimit: 6 * 1024 * 1024, closeOnBackpressureLimit: true, ...this.socketHandlers },
    });
    this.activate(`ws://127.0.0.1:${this.server.port}/workspace/relay`);
    return this.server.port!;
  }
  async handleRequest(request: Request, remoteAddress: string): Promise<Response> {
    let response: Response;
    try {
      if (new URL(request.url).pathname.startsWith("/workspace/api/")) await this.options.authorize?.();
      response = await this.dispatchRequest(request, remoteAddress);
    } catch { response = json({ error: "Workspace access could not be verified; return to Profiles to sign in" }, 401); }
    // Pinned Bun on Windows can stall a browser reusing an idle HTTP socket.
    // End each loopback HTTP exchange explicitly; the relay upgrades separately.
    const headers = new Headers(response.headers);
    headers.set("connection", "close");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  private async dispatchRequest(request: Request, remoteAddress: string): Promise<Response> {
    const extra = await this.options.extraFetch?.(request, remoteAddress);
    if (extra) return extra;
    const url = new URL(request.url);
    if ((url.pathname === "/" || url.pathname === "/workspace" || url.pathname === "/workspace/") && request.method === "GET") {
      if (!isLoopback(remoteAddress)) return json({ error: "Local workspace access required" }, 403);
      return this.asset("/workspace/dashboard.html");
    }
    if (["/workspace/dashboard.html", "/workspace/dashboard.css", "/workspace/dashboard.js", "/workspace/fonts/inter-latin.woff2"].includes(url.pathname) && request.method === "GET") {
      if (!isLoopback(remoteAddress)) return json({ error: "Local workspace access required" }, 403);
      return this.asset(url.pathname);
    }
    if (!url.pathname.startsWith("/workspace/api/")) return json({ error: "Route not found" }, 404);
    if (!trustedLocalRequest(request, remoteAddress)) return json({ error: "Same-origin local workspace request required" }, 403);
    if (this.shutdown) return json({ error: "Workspace is stopping" }, 503);
    if (url.pathname === "/workspace/api/bootstrap" && request.method === "GET") {
      for (const [token, expiry] of this.dashboardTokens) if (expiry < Date.now()) this.dashboardTokens.delete(token);
      if (this.dashboardTokens.size >= 32) this.dashboardTokens.delete(this.dashboardTokens.keys().next().value!);
      const token = sessionToken();
      this.dashboardTokens.set(token, Date.now() + 12 * 60 * 60 * 1000);
      this.dashboardOrigins.add(url.origin);
      return json({ token, relayUrl: this.relayUrl, snapshot: this.snapshot() });
    }
    if (!this.validDashboardToken(request.headers.get("authorization")?.replace(/^Bearer /, ""))) return json({ error: "Workspace authorization required" }, 401);
    const appResponse = await this.options.appFetch?.(request, remoteAddress);
    if (appResponse) return appResponse;
    if (url.pathname === "/workspace/api/sync" && this.sync) {
      try {
        const runtime = this.sync;
        let session;
        if (request.method === "GET") session = runtime.status();
        else if (request.method === "DELETE") { this.draftGroup = undefined; session = await runtime.stop(); }
        else if (request.method === "POST") {
          const body = await boundedJson(request);
          if (body.action === "resume" && Object.keys(body).length === 1) { this.draftGroup = undefined; await this.configureSyncPolicy(false); session = await runtime.resume(); }
          else if (body.action === "save" && typeof body.saveSession === "boolean" && Object.keys(body).every(key => ["action", "saveSession"].includes(key))) session = await runtime.save(body.saveSession);
          else if (Object.keys(body).every(key => ["adminId", "followerIds", "saveSession"].includes(key)) && (body.saveSession === undefined || typeof body.saveSession === "boolean")) { this.draftGroup = undefined; await this.configureSyncPolicy(false); session = await runtime.start(body.adminId, body.followerIds, body.saveSession as boolean | undefined); }
          else throw new Error("Choose browser profiles; external automation endpoints are not accepted");
        } else return json({ error: "Method not allowed" }, 405);
        this.publishSnapshot(); return json({ ...session, snapshot: this.snapshot() });
      } catch (error) { return json({ error: error instanceof Error ? error.message.slice(0, 200) : "Browser following could not change" }, 400); }
    }
    if (url.pathname === "/workspace/api/snapshot" && request.method === "GET") return json({ snapshot: this.snapshot() });
    const proxy = await handleProxyRoute(request, url, { library: this.proxies, manager: this.manager,
      snapshot: () => this.snapshot(), changed: () => this.publishSnapshot() });
    if (proxy) return proxy;
    const workflow = await this.workflowRoutes.handle(request, url);
    if (workflow) return workflow;
    const management = await this.management.handle(request, url);
    if (management) return management;
    const profileRoute = /^\/workspace\/api\/profiles\/([a-zA-Z0-9_-]{1,128})(?:\/(browser|network|delete|cookies))?$/.exec(url.pathname);
    if (profileRoute) return this.profileRequest(request, profileRoute[1]!, profileRoute[2], url);
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    try {
      const body = await boundedJson(request);
      const operation = url.pathname.slice("/workspace/api/".length);
      if (operation === "bulk") {
        const input = body as unknown as BulkProfileInput;
        if (input.origin) approvedOrigin(input.origin);
        for (const page of input.urls ?? []) browsingUrl(page);
        const profiles = await this.manager.bulkCreate(input);
        this.registerProfiles(profiles);
        return json({ profiles, snapshot: this.snapshot() });
      }
      if (operation === "settings") {
        if (!Array.isArray(body.origins)) throw new Error("Origins must be an array");
        this.relay.configure(body.origins, body.pacing);
        await this.configureSyncPolicy();
        const temporary = `${this.settingsFile}.tmp`;
        writeFileSync(temporary, JSON.stringify({ version: 1, origins: this.relay.origins, pacing: this.relay.pacing }), { mode: 0o600 });
        renameSync(temporary, this.settingsFile);
        return json({ snapshot: this.snapshot() });
      }
      if (typeof body.profileId !== "string") throw new Error("Profile ID is required");
      assertSafeProfileId(body.profileId);
      const id = body.profileId;
      if (!this.manager.getProfile(id)) return json({ error: "Profile not found" }, 404);
      if (operation === "start") { await this.manager.start(id); await this.bridge.attach(id); }
      else if (operation === "stop" || operation === "kill") {
        if (!this.sync) this.relay.manual(id, "operator_stop"); await this.bridge.detach(id);
        const stopped = operation === "kill" ? await this.manager.forceKill(id) : await this.manager.stop(id);
        if (!stopped) return json({ error: "Browser shutdown could not be confirmed", snapshot: this.snapshot() }, 409);
      } else if (operation === "manual") {
        if (typeof body.enabled !== "boolean") throw new Error("Manual mode must be boolean");
        if (this.sync) await this.changeRole(id, body.enabled ? "manual" : "follower");
        else if (body.enabled) this.relay.setRole(id, "manual");
        else { this.manager.setManual(id, false); this.relay.setRole(id, "follower"); }
      } else if (operation === "pause") {
        if (typeof body.enabled !== "boolean") throw new Error("Pause mode must be boolean");
        await this.changePause(id, body.enabled);
      } else if (operation === "role") {
        if (!["admin", "follower", "manual"].includes(String(body.role))) throw new Error("Role is invalid");
        if (this.sync) await this.changeRole(id, body.role as SyncRole);
        else { if (body.role !== "manual") this.manager.setManual(id, false); this.relay.setRole(id, body.role as SyncRole); }
      } else if (operation === "navigate") {
        if (typeof body.url !== "string") throw new Error("URL is required");
        if (!this.manager.getLaunch(id)) return json({ error: "Start this browser profile first" }, 409);
        if (!this.canControl(id)) return json({ error: "Switch this profile to manual control first" }, 403);
        browsingUrl(body.url);
        await this.bridge.navigate(id, body.url);
      } else if (operation === "policy") this.manager.setPolicy(id, body as any);
      else return json({ error: "Route not found" }, 404);
      this.publishSnapshot();
      return json({ profile: this.manager.getProfile(id), snapshot: this.snapshot() });
    } catch (error) {
      const message = error instanceof Error && error.message.length <= 200 ? error.message : "Workspace request failed";
      return json({ error: message }, 400);
    }
  }
  private async cleanupProfile(id: string): Promise<void> {
    assertSafeProfileId(id);
    if (this.cleanedProfiles.has(id)) return;
    this.relay.unregister(id);
    await this.bridge.forgetProfile(id);
    this.extensionDirs.delete(id); this.controlQueues.delete(id);
    for (const socket of this.sockets) {
      socket.data.subscribed.delete(id); if (socket.data.focused === id) socket.data.focused = undefined;
      if (socket.data.profileId === id) socket.close(4001, "Profile deleted");
    }
    removeSyncExtension(this.options.stateRoot, id);
    this.extensions.removeProfile(id); this.preparedExtensions.delete(id);
    this.library.removeProfile(id);
    this.workflows.removeProfile(id);
    await this.options.onProfileDeleted?.(id);
    this.cleanedProfiles.add(id);
  }
  private canControl(id: string): boolean {
    if (!this.authorized(id) || !this.manager.getProfile(id) || !this.manager.getLaunch(id)) return false;
    const profile = this.manager.getProfile(id)!, role = this.relay.configFor(id)?.role;
    if (!this.sync) return profile.manual || role === "admin";
    try {
      const session = this.sync.status();
      if (session.followerIds.includes(id)) return false;
      if (session.adminId === id) return true;
      return role !== "follower";
    } catch { return false; }
  }
  private async profileRequest(request: Request, id: string, operation: string | undefined, url: URL): Promise<Response> {
    if (!this.manager.getProfile(id)) return json({ error: "Profile not found" }, 404);
    try {
      if (operation === "browser" || operation === "cookies") {
        if (!["GET", "POST"].includes(request.method)) return json({ error: "Method not allowed" }, 405);
        if (!this.manager.getLaunch(id)) return json({ error: "Start this browser profile first" }, 409);
        if (operation === "browser" && request.method === "GET") return json({ browser: await this.bridge.browserState(id) });
        if (!this.canControl(id)) return json({ error: "Switch this profile to manual control first" }, 403);
        if (operation === "cookies") {
          if (request.method === "GET") return json(await this.bridge.cookies(id, url.searchParams.get("origin")));
          const result = await this.bridge.changeCookies(id, await boundedJson(request));
          return json({ ...result, snapshot: this.snapshot() });
        }
        if (request.method === "GET") return json({ browser: await this.bridge.browserState(id) });
        const command = browserCommand(await boundedJson(request));
        return json({ browser: await this.bridge.browserAction(id, command), snapshot: this.snapshot() });
      }
      if ((operation === undefined && request.method === "DELETE") || (operation === "delete" && request.method === "POST")) {
        const body = await boundedJson(request);
        if (body.confirmation !== id || Object.keys(body).some(key => key !== "confirmation")) return json({ error: "Type the exact profile ID to confirm deletion of its local browser data" }, 400);
        if (!this.manager.canEditProfile(id)) return json({ error: "Stop this profile and finish its lifecycle operation before deleting local data" }, 409);
        const result = await this.manager.deleteProfile(id);
        await this.cleanupProfile(id);
        this.refreshVisible(); this.publishSnapshot();
        return json({ ...result, snapshot: this.snapshot() });
      }
      if (operation === "network" && request.method === "POST") {
        if (!this.manager.canEditProfile(id)) return json({ error: "Stop this profile before changing its network route" }, 409);
        const body = await boundedJson(request);
        if (Object.keys(body).some(key => !["networkMode", "proxy"].includes(key))) throw new Error("Network request contains an unsupported field");
        const profile = this.manager.updateNetwork(id, body as any);
        this.relay.manual(id, "network_changed");
        return json({ profile, snapshot: this.snapshot() });
      }
      return json({ error: "Method not allowed" }, 405);
    } catch (error) {
      // Browser protocol failures can include full addresses and cookie contents.
      // Only our bounded validation messages are safe; runtime failures stay generic.
      const message = error instanceof Error && /^(?:Browser command|Browser action|Browser tab identifier|Choose a browser tab|Browser URL|Enter a complete HTTPS|Use HTTPS, or HTTP|This browser action|Origin is invalid|Use an exact HTTPS|Cookie action must|Cookie request contains|Cookie is invalid|Cookie contains an unsupported|Cookie name or value is invalid|Cookie domain|Cookie path is invalid|Cookie expiry is invalid|Cookie flags are invalid|SameSite=None|Secure cookie prefix|Host cookie prefix|Import at most|Network request contains|Request |network |proxy |stop the profile|This site's cookies exceed)/.test(error.message)
        ? error.message.slice(0, 200) : "Browser request could not finish; the profile remains available";
      return json({ error: message }, 400);
    }
  }
  private asset(path: string): Response {
    const asset = this.options.assets?.[path];
    if (!asset) return json({ error: "Workspace asset is unavailable" }, 503);
    return new Response(asset.body, { headers: { "content-type": asset.contentType, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" } });
  }
  private validDashboardToken(token: unknown): boolean {
    if (typeof token !== "string") return false;
    for (const [candidate, expiry] of this.dashboardTokens) if (expiry > Date.now() && sameToken(token, candidate)) return true;
    return false;
  }
  private async socketMessage(socket: ServerWebSocket<SocketState>, value: string | Buffer): Promise<void> {
    await this.options.authorize?.();
    if (!this.authorized(socket.data.profileId)) throw new Error("Workspace access changed");
    if (Date.now() - socket.data.windowAt > 1000) { socket.data.windowAt = Date.now(); socket.data.windowPackets = 0; }
    if (++socket.data.windowPackets > 120 || Buffer.byteLength(value) > MAX_PACKET_BYTES) { socket.close(4008, "Message limit exceeded"); return; }
    let packet: Record<string, unknown>;
    try { packet = JSON.parse(value.toString()); if (!packet || typeof packet !== "object" || Array.isArray(packet)) throw new Error(); }
    catch { socket.close(4002, "Invalid message"); return; }
    if (!socket.data.client) {
      if (packet.type !== "HELLO") { socket.close(4001, "Authentication required"); return; }
      if (packet.client === "dashboard" && this.validDashboardToken(packet.token)) {
        socket.data.client = "dashboard"; clearTimeout(socket.data.authenticationTimer);
        this.send(socket, { type: "SNAPSHOT", snapshot: this.snapshot() }); return;
      }
      const transport: RelayTransport = { send: data => this.send(socket, data), close: (code, reason) => socket.close(code, reason) };
      if (this.relay.authenticate(packet.profileId, packet.token, transport)) {
        socket.data.client = "profile"; socket.data.profileId = packet.profileId as string; socket.data.transport = transport; clearTimeout(socket.data.authenticationTimer); return;
      }
      socket.close(4001, "Authentication failed"); return;
    }
    if (packet.type === "PING") { this.send(socket, { type: "PONG" }); return; }
    if (packet.type === "PONG") return;
    if (socket.data.client === "profile") {
      if (packet.type === "PAGE") this.bridge.setActivePage(socket.data.profileId!, packet.url);
      this.relay.receive(socket.data.profileId!, socket.data.transport!, packet); return;
    }
    if (packet.type === "SUBSCRIBE") {
      if (!Array.isArray(packet.profileIds) || packet.profileIds.length > MAX_VISIBLE_PROFILES || packet.profileIds.some(id => typeof id !== "string")) { socket.close(4002, "Invalid subscription"); return; }
      try { socket.data.subscribed = new Set((packet.profileIds as string[]).filter(id => this.manager.getProfile(id) && this.manager.getLaunch(id))); }
      catch { socket.close(4002, "Invalid subscription"); return; }
      this.refreshVisible(); return;
    }
    if (packet.type === "FOCUS") {
      if (packet.profileId === null) { socket.data.focused = undefined; return; }
      if (typeof packet.profileId !== "string" || !socket.data.subscribed.has(packet.profileId)) return;
      socket.data.focused = packet.profileId; return;
    }
    if (packet.type === "CONTROL") {
      try {
        const input = safeManualControl(packet);
        if (input.profileId !== socket.data.focused || !socket.data.subscribed.has(input.profileId)) throw new Error("Focus this browser tile before controlling it");
        await this.dispatchControl(socket, input);
      } catch { this.send(socket, { type: "CONTROL_ERROR", profileId: packet.profileId, error: "Control requires a focused administrator or manual browser profile" }); }
    }
  }
  private dispatchControl(socket: ServerWebSocket<SocketState>, input: ManualControl): Promise<void> {
    const queue = this.controlQueues.get(input.profileId) ?? { count: 0, chain: Promise.resolve() };
    if (queue.count >= 32) return Promise.reject(new Error("Manual control queue exceeded its limit"));
    const enqueuedAt = Date.now();
    queue.count++; this.controlQueues.set(input.profileId, queue);
    const task = queue.chain.then(async () => {
      if (!this.authorized(input.profileId) || !this.canControl(input.profileId) || this.shutdown || Date.now() - enqueuedAt > 3000 || socket.data.focused !== input.profileId || !socket.data.subscribed.has(input.profileId)) throw new Error("Manual input is stale or its tile lost focus");
      await this.bridge.control(input);
    });
    queue.chain = task.catch(() => {}).finally(() => { queue.count--; if (!queue.count && this.controlQueues.get(input.profileId) === queue) this.controlQueues.delete(input.profileId); });
    return task;
  }
  private send(socket: ServerWebSocket<SocketState>, packet: unknown): void { socket.send(JSON.stringify(packet)); }
  private refreshVisible(): void {
    const ids = new Set<string>();
    for (const socket of this.sockets) if (socket.data.client === "dashboard") for (const id of socket.data.subscribed) if (ids.size < MAX_VISIBLE_PROFILES) ids.add(id);
    this.bridge.setVisible([...ids]);
  }
  private publishFrame(frame: LiveFrame): void {
    if (!this.authorized(frame.profileId)) return;
    for (const socket of this.sockets) if (socket.data.client === "dashboard" && socket.data.subscribed.has(frame.profileId)) {
      if (socket.getBufferedAmount() < 4 * 1024 * 1024) this.send(socket, frame);
    }
  }
  private publishProfilePacket(profileId: string, packet: unknown): void {
    if (!this.authorized(profileId)) return;
    for (const socket of this.sockets) if (socket.data.client === "dashboard" && socket.data.subscribed.has(profileId)) this.send(socket, packet);
  }
  private publishSnapshot(): void {
    if (this.snapshotTimer || this.shutdown) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      try {
        const snapshot = this.snapshot();
        for (const socket of this.sockets) if (socket.data.client === "dashboard") this.send(socket, { type: "SNAPSHOT", snapshot });
      } catch {
        for (const socket of this.sockets) if (socket.data.client === "dashboard") socket.close(4001, "Workspace access changed; reconnect from Profiles");
      }
    }, 80);
  }
  /** Stop transports and producers before the owner drains its HTTP listener. */
  quiesce(): Promise<void> {
    if (this.quiescing) return this.quiescing;
    this.quiescing = this.quiesceOwnedTransports();
    return this.quiescing;
  }
  private async quiesceOwnedTransports(): Promise<void> {
    this.shutdown = true;
    if (this.options.syncController === "relay") await this.sync?.suspend?.("Following is paused while GameBrowser closes; saved sessions resume only when requested");
    this.manager.beginShutdown?.();
    this.workflows.stop();
    this.unsubscribe();
    await this.browserFollowing?.stop();
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.relay.stop();
    for (const socket of this.sockets) socket.close(1001, "Workspace stopping");
    this.sockets.clear();
    await this.bridge.stop();
  }
  async stop(options: { closeBrowsers?: boolean; stopSync?: boolean } = {}): Promise<void> {
    if (options.stopSync !== false) await this.sync?.stop();
    await this.quiesce();
    if (options.closeBrowsers === false) {
      this.server?.stop(true); this.server = undefined;
      this.dashboardTokens.clear(); this.manager.dispose(); return;
    }
    // No browser exists during initial warmup. Cancel its exact owned helper
    // before waiting for starts; active-browser teardown still needs collectors.
    let helpersStopped = true;
    if (!this.manager.list().some(p => this.manager.getLaunch(p.id))) helpersStopped = await windowsProcessScheduler.drain();
    const ids = new Set([...this.manager.list().filter(p => this.manager.getLaunch(p.id)).map(p => p.id), ...(this.manager.pendingStartIds?.() ?? [])]);
    const results = await Promise.allSettled([...ids].map(id => this.manager.stop(id)));
    helpersStopped = await windowsProcessScheduler.drain() && helpersStopped;
    this.server?.stop(true); this.server = undefined;
    this.dashboardTokens.clear();
    if (results.some(result => result.status === "rejected" || result.value !== true) || this.manager.list().some(p => this.manager.getLaunch(p.id))) {
      throw new Error("Owned browser shutdown could not be confirmed; launch records remain quarantined");
    }
    if (!helpersStopped) throw new Error("Native process helper shutdown could not be confirmed; the helper remains quarantined");
    this.manager.dispose();
  }
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", "access-control-allow-origin": "" } });
}
