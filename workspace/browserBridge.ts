import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { LaunchInfo } from "../types.ts";
import { callFirefoxOwner } from "../firefox-runtime.ts";
import { resolvePlaywrightRuntime } from "../playwright-runtime.ts";
import { approvedOrigin, approvedUrl, browserCommand, browsingUrl, jpegDimensions, MAX_BROWSER_TABS, publicPageUrl, sameToken, sessionToken, siteCookies, type BrowserCommand, type ProfileBrowserState, type LiveFrame, type ManualControl, type SyncProfileConfig, type SyncController } from "./protocol.ts";
import { sensitiveTargetPattern } from "./eventPolicy.ts";
import type { BrowserWorkflowStep } from "./workflowEngine.ts";
import type { RelayTransport } from "./syncRelay.ts";
import { validateDesktopScreen } from "./displayPolicy.ts";

interface TrackedTab { id: string; page: Page; title: string; loading: boolean; viewportReady: Promise<void>; quarantined: boolean; }
class NavigationCancelled extends Error { constructor() { super("Browser navigation cancelled"); this.name = "NavigationCancelled"; } }
interface PendingNavigation { controller: AbortController; }
interface Connection { browser: Browser; context: BrowserContext; page?: Page; viewport?: { width: number; height: number }; busy: boolean; stopEpoch: number; navigations: Map<Page, PendingNavigation>; geometryEpoch: number; generation: string; transport?: RelayTransport; geometry?: { page: Page; width: number; height: number; at: number; url: string }; tabs: Map<string, TrackedTab>; tabIds: Map<Page, string>; pendingTabs: number; tabQueue: Promise<void>; trustedExtensionOrigins: Set<string>; stateTimer?: ReturnType<typeof setTimeout>; browserError?: string; firefoxPublish?: (page: Page) => void; }
interface BridgeOptions {
  controller?: SyncController;
  getLaunch(profileId: string): LaunchInfo | null;
  /** Certifies the current owned process before any endpoint attachment or reuse. */
  authorizeLaunch?(profileId: string): Promise<boolean>;
  getConfig(profileId: string): SyncProfileConfig | undefined;
  /** Production supplies the saved desktop screen, independent of dashboard size. */
  getViewport?(profileId: string): { width: number; height: number } | undefined;
  canControl(profileId: string): boolean;
  onFrame(frame: LiveFrame): void;
  onError(profileId: string, message: string): void;
  onFirefoxConnect?(profileId: string, token: string, transport: RelayTransport): boolean;
  onFirefoxPacket?(profileId: string, transport: RelayTransport, packet: unknown): void;
  onDisconnect?(profileId: string): void;
  onNavigation?(profileId: string, url: string): void;
  onBrowserState?(state: ProfileBrowserState): void;
  beforeBrowserAction?(profileId: string): void;
  contentScriptPath?: string;
  connect?: (launch: LaunchInfo) => Promise<Browser>;
}
/** Read actual browser pixels; never an iframe masquerading as a profile or a desktop screen capture. */
export class BrowserBridge {
  private connections = new Map<string, Connection>();
  private connecting = new Map<string, Promise<Connection>>();
  private visible = new Set<string>();
  private suspended = new Set<string>();
  private frameSequences = new Map<string, number>();
  private interval?: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(private options: BridgeOptions) {}
  start(): void {
    if (this.interval) return;
    this.stopped = false;
    this.interval = setInterval(() => { for (const id of this.visible) void this.frame(id); }, 500);
    this.interval.unref?.();
  }
  setVisible(ids: string[]): void { this.visible = new Set(ids.slice(0, 12)); }
  async attach(profileId: string): Promise<void> { this.suspended.delete(profileId); await this.connection(profileId); }
  setActivePage(profileId: string, url: unknown): void {
    const connection = this.connections.get(profileId), config = this.options.getConfig(profileId);
    if (!connection || !config || typeof url !== "string") return;
    // Manual workspace tabs are selected by their opaque Page identity. MV3
    // PAGE reports contain only a redacted URL and can arrive after another
    // tab was explicitly selected; they cannot establish manual tab focus.
    if (config.role === "manual") return;
    try { approvedUrl(url, config.origins); } catch { return; }
    const candidates = connection.context.pages().filter(page => !page.isClosed() && publicPageUrl(page.url()) === publicPageUrl(url));
    const page = connection.page && candidates.includes(connection.page) ? connection.page : candidates.length === 1 ? candidates[0] : undefined;
    if (page) {
      if (page !== connection.page || connection.geometry?.url !== page.url()) this.invalidateGeometry(connection);
      connection.page = page;
      this.publishBrowserState(profileId, connection);
    }
  }
  private assertLaunchGeneration(profileId: string, generation: string): void {
    const current = this.options.getLaunch(profileId);
    if (this.stopped || this.suspended.has(profileId) || !current || `${current.pid}:${current.startedAt}:${current.ws}` !== generation) throw new Error("Browser launch or workspace authorization changed");
  }
  private async connection(profileId: string): Promise<Connection> {
    if (this.stopped || this.suspended.has(profileId)) throw new Error("Browser workspace profile is detached");
    const launch = this.options.getLaunch(profileId);
    if (!launch) throw new Error("Browser profile is stopped");
    const generation = `${launch.pid}:${launch.startedAt}:${launch.ws}`;
    if (this.options.authorizeLaunch && !await this.options.authorizeLaunch(profileId)) throw new Error("Browser launch could not be certified");
    this.assertLaunchGeneration(profileId, generation);
    const pending = this.connecting.get(profileId);
    if (pending) {
      const connection = await pending; this.assertLaunchGeneration(profileId, generation);
      if (connection.generation !== generation) throw new Error("Browser launch changed during attachment");
      return connection;
    }
    const existing = this.connections.get(profileId);
    if (existing?.generation === generation && existing.browser.isConnected()) return existing;
    const promise = this.connect(profileId, launch, generation).finally(() => this.connecting.delete(profileId));
    this.connecting.set(profileId, promise);
    return promise;
  }
  private async connect(profileId: string, launch: LaunchInfo, generation: string): Promise<Connection> {
    await this.detach(profileId, false);
    this.assertLaunchGeneration(profileId, generation);
    // Use the saved viewport dimensions without regenerating profile identity.
    let viewport: { width: number; height: number } | undefined;
    try { viewport = this.options.getViewport ? validateDesktopScreen(this.options.getViewport(profileId)) : undefined; }
    catch { throw new Error("Stop this profile and set its desktop screen to width 320–4096 and height 200–4096 within the live-view pixel budget before opening its browser"); }
    const browser = this.options.connect ? await this.options.connect(launch) : await connectBrowser(launch);
    if (this.stopped || this.suspended.has(profileId) || !this.options.getLaunch(profileId) || `${this.options.getLaunch(profileId)!.pid}:${this.options.getLaunch(profileId)!.startedAt}:${this.options.getLaunch(profileId)!.ws}` !== generation) {
      await disconnectBrowser(browser);
      throw new Error("Browser profile changed during connection");
    }
    const context = browser.contexts()[0];
    if (!context) { await disconnectBrowser(browser); throw new Error("Browser context is unavailable"); }
    const connection: Connection = { browser, context, viewport, busy: false, stopEpoch: 0, navigations: new Map(), geometryEpoch: 0, generation, tabs: new Map(), tabIds: new Map(), pendingTabs: 0, tabQueue: Promise.resolve(), trustedExtensionOrigins: new Set() };
    this.connections.set(profileId, connection);
    browser.on("disconnected", () => {
      if (this.connections.get(profileId) !== connection) return;
      this.cancelNavigations(connection);
      this.connections.delete(profileId);
      this.options.onDisconnect?.(profileId);
      this.options.onError(profileId, "Browser disconnected; its saved synchronization assignment is retained");
    });
    this.trackExistingPages(profileId, connection);
    if (typeof context.on === "function") context.on("page", page => {
      if (this.connections.get(profileId) !== connection || page.isClosed()) return;
      if (connection.tabs.size >= MAX_BROWSER_TABS) { void page.close({ runBeforeUnload: false }).catch(() => {}); return; }
      const previous = connection.page, tab = this.trackPage(profileId, connection, page);
      void tab.viewportReady.then(() => {
        if (this.connections.get(profileId) === connection && !page.isClosed() && (connection.page === previous || connection.page === page)) this.selectPage(profileId, connection, page);
      }).catch(() => this.quarantinePage(profileId, connection, tab));
    });
    try {
      await Promise.all([...connection.tabs.values()].map(tab => tab.viewportReady));
      if (this.connections.get(profileId) !== connection || this.suspended.has(profileId)) throw new Error("Browser attachment changed while preparing its desktop viewport");
      if (launch.engine === "firefox" && (this.options.controller ?? this.options.getConfig(profileId)?.controller) !== "worker") await this.installFirefoxBridge(profileId, connection);
    } catch {
      await this.detach(profileId); this.options.onDisconnect?.(profileId);
      throw new Error("Browser desktop setup failed; check the saved screen size, then stop and restart this profile");
    }
    this.publishBrowserState(profileId, connection);
    return connection;
  }
  private async installFirefoxBridge(profileId: string, connection: Connection): Promise<void> {
    const config = this.options.getConfig(profileId);
    if (!config || !this.options.onFirefoxConnect || !this.options.onFirefoxPacket) return;
    const script = readFileSync(this.options.contentScriptPath ?? join(import.meta.dir, "..", "extensions", "stakemode-sync", "content.js"), "utf8");
    const context = connection.context;
    this.page(profileId, connection);
    const transport: RelayTransport = {
      send: packet => {
        for (const page of context.pages()) {
          if (page.isClosed()) continue;
          const isConfig = (packet as { type?: string }).type === "CONFIG";
          if (!isConfig && page !== connection.page) continue;
          const delivery = isConfig ? { ...(packet as object), active: page === connection.page } : packet;
          void page.evaluate((value: any) => {
            const target = window as any;
            if (value.type === "CONFIG") target.__stakemodeConfigure?.(value);
            else target.__stakemodeReceive?.(value);
          }, delivery).catch(() => this.options.onError(profileId, "Firefox page delivery failed"));
        }
      },
      close: () => { for (const page of context.pages()) void page.evaluate(() => (window as any).__stakemodeDispose?.()).catch(() => {}); },
    };
    connection.transport = transport;
    const captureNonce = sessionToken(), bindingName = `__stakemodeCapture_${sessionToken().replaceAll("-", "_")}`;
    await context.exposeBinding(bindingName, async (source, packet, nonce) => {
      if (!sameToken(nonce, captureNonce)) return;
      if (source.frame !== source.page.mainFrame() || source.page.isClosed() || source.page !== connection.page) return;
      const current = this.options.getConfig(profileId);
      if (!current) return;
      try { approvedUrl(source.page.url(), current.origins); } catch { return; }
      this.options.onFirefoxPacket!(profileId, transport, { type: "PAGE", url: source.page.url(), origin: new URL(source.page.url()).origin });
      this.options.onFirefoxPacket!(profileId, transport, packet);
    });
    const source = `(() => {
      const rawCapture = window[${JSON.stringify(bindingName)}];
      Object.defineProperty(window, ${JSON.stringify(bindingName)}, { value: rawCapture, writable: false, configurable: false });
      const privateCaptureNonce = ${JSON.stringify(captureNonce)};
      const __stakemodePrivateSend = (packet) => rawCapture(packet, privateCaptureNonce);
      ${script}
      window.__stakemodeConfigure && window.__stakemodeConfigure(${JSON.stringify({ type: "CONFIG", profileId, role: "manual", origins: config.origins, epoch: config.epoch, active: false })});
    })();`;
    await context.addInitScript({ content: source });
    for (const page of context.pages()) await page.evaluate(source).catch(() => {});
    if (!this.options.onFirefoxConnect(profileId, config.token, transport)) throw new Error("Firefox synchronization authentication failed");
    const publishPage = (page: Page) => {
      if (page.isClosed()) return;
      const current = this.options.getConfig(profileId);
      if (!current) return;
      try { approvedUrl(page.url(), current.origins); }
      catch { this.options.onNavigation?.(profileId, page.url()); return; }
      this.invalidateGeometry(connection);
      connection.page = page;
      transport.send({ type: "CONFIG", profileId, role: current.role, origins: current.origins, epoch: current.epoch });
      this.options.onFirefoxPacket!(profileId, transport, { type: "PAGE", origin: new URL(page.url()).origin, url: page.url() });
    };
    connection.firefoxPublish = publishPage;
    if (connection.page) publishPage(connection.page);
  }
  private trackExistingPages(profileId: string, connection: Connection): void {
    for (const page of connection.context.pages().filter(page => !page.isClosed()).slice(0, MAX_BROWSER_TABS)) this.trackPage(profileId, connection, page);
    if (!connection.page && connection.tabs.size) this.page(profileId, connection);
  }
  private trackPage(profileId: string, connection: Connection, page: Page): TrackedTab {
    const knownId = connection.tabIds.get(page), known = knownId && connection.tabs.get(knownId);
    if (known) return known;
    const tab: TrackedTab = { id: `tab_${sessionToken().slice(0, 22)}`, page, title: "", loading: false, viewportReady: Promise.resolve(), quarantined: false };
    connection.tabs.set(tab.id, tab); connection.tabIds.set(page, tab.id);
    tab.viewportReady = this.prepareViewport(profileId, connection, page);
    void tab.viewportReady.catch(() => {}); // Every input/capture also awaits it.
    if (typeof page.on === "function") {
      page.on("framenavigated", frame => {
        if (frame !== page.mainFrame()) return;
        tab.loading = true;
        if (connection.page === page) {
          this.invalidateGeometry(connection);
          this.options.onNavigation?.(profileId, page.url());
          connection.firefoxPublish?.(page);
        }
        void this.refreshTitle(profileId, connection, tab);
        this.publishBrowserState(profileId, connection);
      });
      const loaded = () => { tab.loading = false; void this.refreshTitle(profileId, connection, tab); this.publishBrowserState(profileId, connection); };
      page.on("domcontentloaded", loaded); page.on("load", loaded);
      page.on("close", () => {
        this.cancelNavigation(connection, page);
        connection.tabs.delete(tab.id); connection.tabIds.delete(page);
        if (connection.page === page) {
          this.invalidateGeometry(connection); connection.page = undefined;
          const replacement = [...connection.tabs.values()].findLast(candidate => !candidate.page.isClosed());
          if (replacement) this.selectPage(profileId, connection, replacement.page);
        }
        this.publishBrowserState(profileId, connection);
      });
      page.on("crash", () => { tab.loading = false; connection.browserError = "This tab stopped responding. Reload or close it to continue."; this.publishBrowserState(profileId, connection); });
    }
    void this.refreshTitle(profileId, connection, tab);
    return tab;
  }
  private async prepareViewport(profileId: string, connection: Connection, page: Page): Promise<void> {
    if (!connection.viewport) return;
    this.invalidateGeometry(connection);
    try {
      await bounded(page.setViewportSize({ ...connection.viewport }), 5000);
      if (this.connections.get(profileId) !== connection || page.isClosed()) throw new Error("Browser changed during desktop viewport setup");
    } finally { this.invalidateGeometry(connection); }
  }
  private async readyPage(profileId: string, connection: Connection, page: Page): Promise<void> {
    const tab = this.trackPage(profileId, connection, page);
    await tab.viewportReady;
    if (this.connections.get(profileId) !== connection || tab.quarantined || page.isClosed()) throw new Error("Browser tab desktop viewport is unavailable");
  }
  private quarantinePage(profileId: string, connection: Connection, tab: TrackedTab): void {
    if (this.connections.get(profileId) !== connection || tab.quarantined) return;
    tab.quarantined = true; tab.loading = false; this.cancelNavigation(connection, tab.page); this.invalidateGeometry(connection);
    connection.browserError = "The new tab's desktop viewport could not be prepared. Close it or restart this profile.";
    this.options.beforeBrowserAction?.(profileId); this.publishBrowserState(profileId, connection);
    void bounded(tab.page.close({ runBeforeUnload: false }), 3000).catch(() => {});
  }
  private async refreshTitle(profileId: string, connection: Connection, tab: TrackedTab): Promise<void> {
    if (tab.page.isClosed() || typeof tab.page.title !== "function") return;
    try {
      const title = await bounded(tab.page.title(), 1000);
      if (typeof title !== "string") return;
      const clean = title.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160);
      if (tab.title !== clean) { tab.title = clean; this.publishBrowserState(profileId, connection); }
    } catch { /* Navigation can temporarily replace the document. */ }
  }
  private selectPage(profileId: string, connection: Connection, page: Page): void {
    if (connection.page !== page) this.invalidateGeometry(connection);
    connection.page = page;
    this.options.onNavigation?.(profileId, page.url());
    connection.firefoxPublish?.(page);
    this.publishBrowserState(profileId, connection);
  }
  private state(profileId: string, connection: Connection, privateUrls: boolean): ProfileBrowserState {
    const tabs = [...connection.tabs.values()].filter(tab => !tab.page.isClosed()).slice(0, MAX_BROWSER_TABS).map(tab => {
      const rawUrl = tab.page.url();
      let title = tab.title;
      if (!privateUrls) { try { title = new URL(rawUrl).hostname || "New tab"; } catch { title = "New tab"; } }
      return { id: tab.id, title: title || (rawUrl === "about:blank" ? "New tab" : "Loading page"), url: this.pageUrl(connection, rawUrl, privateUrls).slice(0, privateUrls ? 8192 : 512), loading: tab.loading };
    });
    return { profileId, activeTabId: connection.page ? connection.tabIds.get(connection.page) ?? null : null, tabs,
      loading: !!connection.page && !!connection.tabs.get(connection.tabIds.get(connection.page) ?? "")?.loading,
      canGoBack: null, canGoForward: null, ...(!privateUrls ? { redacted: true } : {}), ...(connection.browserError ? { error: connection.browserError } : {}) };
  }
  private publishBrowserState(profileId: string, connection: Connection): void {
    if (!this.options.onBrowserState || connection.stateTimer || this.stopped || this.connections.get(profileId) !== connection) return;
    connection.stateTimer = setTimeout(() => {
      connection.stateTimer = undefined;
      if (this.connections.get(profileId) === connection) this.options.onBrowserState?.(this.state(profileId, connection, false));
    }, 80);
    connection.stateTimer.unref?.();
  }
  private assertReadAuthority(profileId: string, connection: Connection, page?: Page): void {
    this.assertLaunchGeneration(profileId, connection.generation);
    if (this.connections.get(profileId) !== connection || page?.isClosed()) throw new Error("Browser attachment or workspace read authorization changed");
  }
  private assertAuthority(profileId: string, connection: Connection, page?: Page): void {
    this.assertReadAuthority(profileId, connection, page);
    if (!this.options.canControl(profileId)) throw new Error("Browser control authorization changed");
  }
  async browserState(profileId: string): Promise<ProfileBrowserState> {
    const connection = await this.connection(profileId);
    this.trackExistingPages(profileId, connection);
    if (connection.page) await this.readyPage(profileId, connection, connection.page);
    await Promise.all([...connection.tabs.values()].map(tab => this.refreshTitle(profileId, connection, tab)));
    this.assertReadAuthority(profileId, connection);
    const state = this.state(profileId, connection, true);
    const page = connection.page;
    if (page && this.options.getLaunch(profileId)?.engine !== "firefox" && typeof connection.context.newCDPSession === "function") {
      let session: Awaited<ReturnType<BrowserContext["newCDPSession"]>> | undefined;
      try {
        session = await bounded(connection.context.newCDPSession(page), 2000);
        this.assertReadAuthority(profileId, connection, page);
        const history = await bounded(session.send("Page.getNavigationHistory"), 2000);
        state.canGoBack = history.currentIndex > 0;
        state.canGoForward = history.currentIndex < history.entries.length - 1;
      } catch { /* Unknown history remains operable through native Back/Forward. */ }
      finally { if (session) await bounded(session.detach(), 1000).catch(() => {}); }
    }
    this.assertReadAuthority(profileId, connection);
    return state;
  }
  async browserAction(profileId: string, value: BrowserCommand): Promise<ProfileBrowserState> {
    const command = browserCommand(value);
    if (!this.options.canControl(profileId)) throw new Error("Switch this profile to manual control to use browser controls");
    const connection = await this.connection(profileId);
    if (!this.options.canControl(profileId)) throw new Error("This profile is no longer under direct operator control");
    this.options.beforeBrowserAction?.(profileId);
    connection.browserError = undefined;
    this.trackExistingPages(profileId, connection);
    const stopEpoch = connection.stopEpoch;
    if (command.action === "stop") connection.stopEpoch++;
    let page: Page | undefined, cancelled = false;
    if (command.tabId) {
      const tab = connection.tabs.get(command.tabId);
      if (!tab || tab.page.isClosed()) throw new Error("This browser tab is no longer available");
      page = tab.page;
    } else if (command.action !== "new-tab") page = this.page(profileId, connection);
    try {
      if (page && command.action !== "close-tab" && command.action !== "stop") await this.readyPage(profileId, connection, page);
      this.assertAuthority(profileId, connection, page);
      if (command.action === "new-tab") {
        page = await this.newPage(profileId, connection);
        this.assertAuthority(profileId, connection, page);
        this.selectPage(profileId, connection, page);
        await page.bringToFront();
        if (command.url !== "about:blank") await this.navigatePage(profileId, connection, page, command.url!);
      } else if (!page) throw new Error("Browser has no available tab");
      else if (command.action === "select-tab") {
        this.selectPage(profileId, connection, page); await page.bringToFront();
      } else if (command.action === "close-tab") {
        if ([...connection.tabs.values()].filter(tab => !tab.page.isClosed()).length === 1) {
          const replacement = await this.newPage(profileId, connection);
          this.selectPage(profileId, connection, replacement); await replacement.bringToFront();
        }
        this.assertAuthority(profileId, connection, page);
        await page.close({ runBeforeUnload: false });
        this.assertAuthority(profileId, connection);
        const oldId = connection.tabIds.get(page); if (oldId) connection.tabs.delete(oldId); connection.tabIds.delete(page);
        if (connection.page === page) { connection.page = undefined; const next = this.page(profileId, connection); this.selectPage(profileId, connection, next); await next.bringToFront(); }
      } else if (command.action === "navigate") {
        this.selectPage(profileId, connection, page); await this.navigatePage(profileId, connection, page, command.url!);
      } else if (command.action === "stop") {
        this.cancelNavigation(connection, page);
        const stoppedTab = connection.tabs.get(connection.tabIds.get(page) ?? ""); if (stoppedTab) stoppedTab.loading = false;
        this.invalidateGeometry(connection); this.publishBrowserState(profileId, connection);
        if (this.options.getLaunch(profileId)?.engine !== "firefox" && typeof connection.context.newCDPSession === "function") {
          const session = await bounded(connection.context.newCDPSession(page), 3000);
          try { this.assertAuthority(profileId, connection, page); await bounded(session.send("Page.stopLoading"), 3000); } finally { await bounded(session.detach(), 1000).catch(() => {}); }
          // CDP acknowledgement need not resolve Playwright's lifecycle waiter.
          // Stop the committed document's parser/streams as well, best effort.
          this.assertAuthority(profileId, connection, page);
          await bounded(page.evaluate(() => window.stop()), 3000).catch(() => {});
        } else await bounded(page.evaluate(() => window.stop()), 3000);
        const tab = connection.tabs.get(connection.tabIds.get(page) ?? ""); if (tab) tab.loading = false;
      } else {
        this.invalidateGeometry(connection);
        const tab = connection.tabs.get(connection.tabIds.get(page) ?? ""); if (tab) tab.loading = true;
        await this.waitNavigation(profileId, connection, page, async assertActive => {
          await bounded(page!.bringToFront(), 3000); assertActive();
          if (command.action === "back") return page!.goBack({ waitUntil: "domcontentloaded", timeout: 15000 });
          if (command.action === "forward") return page!.goForward({ waitUntil: "domcontentloaded", timeout: 15000 });
          return page!.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
        });
        if (tab) tab.loading = false;
      }
    } catch (error) {
      if (error instanceof NavigationCancelled) cancelled = true;
      else {
      if (command.action === "stop" || connection.stopEpoch === stopEpoch) connection.browserError = error instanceof Error && /tab before opening another/.test(error.message)
        ? error.message : error instanceof Error && /timeout/i.test(error.name)
          ? "Navigation timed out. The tab remains available; stop loading or enter another address."
          : "The browser action could not finish. The tab remains available; reload it or enter another address.";
      const tab = page && connection.tabs.get(connection.tabIds.get(page) ?? ""); if (tab) tab.loading = false;
      }
    }
    if (this.connections.get(profileId) !== connection) throw new NavigationCancelled();
    this.assertAuthority(profileId, connection);
    if (!cancelled) {
      this.invalidateGeometry(connection);
      this.options.onNavigation?.(profileId, connection.page?.url() ?? "about:blank");
      this.publishBrowserState(profileId, connection);
    }
    return this.browserState(profileId);
  }
  private async newPage(profileId: string, connection: Connection): Promise<Page> {
    if (connection.pendingTabs >= MAX_BROWSER_TABS) throw new Error("Close a tab before opening another; each profile supports 24 tabs");
    const predecessor = connection.tabQueue;
    let release!: () => void;
    connection.tabQueue = new Promise<void>(resolve => { release = resolve; });
    connection.pendingTabs++;
    try {
      await predecessor;
      if (this.connections.get(profileId) !== connection || !this.options.canControl(profileId)) throw new Error("Browser attachment or control authorization changed");
      this.trackExistingPages(profileId, connection);
      if (connection.tabs.size >= MAX_BROWSER_TABS) throw new Error("Close a tab before opening another; each profile supports 24 tabs");
      const page = await bounded(connection.context.newPage(), 10000);
      if (this.connections.get(profileId) !== connection || !this.options.canControl(profileId) || page.isClosed()) throw new Error("Browser tab or control authorization changed before it opened");
      const tab = this.trackPage(profileId, connection, page);
      try { await tab.viewportReady; }
      catch (error) { this.quarantinePage(profileId, connection, tab); throw error; }
      this.assertAuthority(profileId, connection, page);
      return page;
    } finally { connection.pendingTabs--; release(); }
  }
  private async navigatePage(profileId: string, connection: Connection, page: Page, url: string): Promise<void> {
    this.invalidateGeometry(connection);
    const tab = connection.tabs.get(connection.tabIds.get(page) ?? ""); if (tab) tab.loading = true;
    this.options.onNavigation?.(profileId, url);
    this.publishBrowserState(profileId, connection);
    await this.waitNavigation(profileId, connection, page, async assertActive => {
      await bounded(page.bringToFront(), 3000); assertActive();
      return page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    });
    if (tab) tab.loading = false;
  }
  private cancelNavigation(connection: Connection, page: Page): void { connection.navigations.get(page)?.controller.abort(); }
  private cancelNavigations(connection: Connection): void { for (const pending of [...connection.navigations.values()]) pending.controller.abort(); }
  /** A native stop may leave goto's DOMContentLoaded promise pending. Own the
   * application wait separately and always consume late native rejections. */
  private waitNavigation<T>(profileId: string, connection: Connection, page: Page, operation: (assertActive: () => void) => Promise<T>): Promise<T> {
    this.cancelNavigation(connection, page);
    const pending: PendingNavigation = { controller: new AbortController() };
    connection.navigations.set(page, pending);
    const assertActive = () => { this.assertAuthority(profileId, connection, page); if (pending.controller.signal.aborted || connection.navigations.get(page) !== pending) throw new NavigationCancelled(); };
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, value?: T) => {
        if (settled) return; settled = true;
        pending.controller.signal.removeEventListener("abort", abort);
        if (connection.navigations.get(page) === pending) connection.navigations.delete(page);
        if (error) reject(error); else resolve(value as T);
      };
      const abort = () => finish(new NavigationCancelled());
      pending.controller.signal.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(() => { assertActive(); return operation(assertActive); }).then(value => {
        try { assertActive(); finish(undefined, value); } catch (error) { finish(error); }
      }, error => finish(error));
    });
  }
  /** Only the authenticated server may call this with an enabled prepared
   * extension's recorded origin and manifest-validated popup/options path. */
  async openExtensionPage(profileId: string, target: { origin: string; entrypoint: string }): Promise<ProfileBrowserState> {
    const { origin, entrypoint } = target;
    if (!/^(?:chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(origin)
      || typeof entrypoint !== "string" || !entrypoint.length || entrypoint.length > 1024 || /[\\?#:\x00-\x20\x7f]/.test(entrypoint) || entrypoint.startsWith("/")) throw new Error("Extension page identity is invalid");
    try { if (entrypoint.split("/").some(part => [".", ".."].includes(decodeURIComponent(part)) || /[/\\]/.test(decodeURIComponent(part)))) throw new Error(); }
    catch { throw new Error("Extension page path is invalid"); }
    if (!this.options.canControl(profileId)) throw new Error("Switch this profile to manual control to open extension pages");
    const connection = await this.connection(profileId);
    const launch = this.options.getLaunch(profileId);
    if ((launch?.engine === "firefox") !== origin.startsWith("moz-extension://")) throw new Error("Extension page does not match the browser engine");
    this.options.beforeBrowserAction?.(profileId);
    const url = `${origin}/${entrypoint}`;
    const page = await this.newPage(profileId, connection);
    this.assertAuthority(profileId, connection, page);
    this.selectPage(profileId, connection, page); await page.bringToFront();
    try {
      const response = await this.waitNavigation(profileId, connection, page, async assertActive => { assertActive(); return page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }); });
      const actual = new URL(page.url());
      if ((response ? response.status() < 200 || response.status() >= 300 : launch?.engine !== "firefox")
        || `${actual.protocol}//${actual.host}` !== origin || actual.href !== new URL(url).href)
        throw new Error("Extension page is unavailable");
      if (launch?.engine === "firefox") {
        // Gecko's moz-extension channel is not an HTTP channel and may not
        // produce a Playwright Response. Verify the committed native document,
        // rejecting error documents even when the address still shows its URL.
        const committed = await bounded(page.evaluate(() => ({ href: location.href, uri: document.documentURI,
          contentType: document.contentType, readyState: document.readyState })), 5000);
        if (committed.href !== new URL(url).href || committed.uri !== new URL(url).href
          || !["text/html", "application/xhtml+xml"].includes(committed.contentType)
          || !["interactive", "complete"].includes(committed.readyState)) throw new Error("Extension document is unavailable");
      }
      connection.trustedExtensionOrigins.add(origin);
      connection.browserError = undefined;
    } catch (error) { if (!(error instanceof NavigationCancelled)) connection.browserError = "The installed extension page could not be verified. Stop the profile and check its extension assignment."; }
    if (this.connections.get(profileId) !== connection) throw new NavigationCancelled();
    this.invalidateGeometry(connection); this.publishBrowserState(profileId, connection);
    return this.browserState(profileId);
  }
  private isTrustedExtensionPage(connection: Connection, value: string): boolean {
    try { const url = new URL(value); return !url.username && !url.password && !url.port && connection.trustedExtensionOrigins.has(`${url.protocol}//${url.host}`); }
    catch { return false; }
  }
  private pageUrl(connection: Connection, value: string, privateUrls: boolean): string {
    if (!this.isTrustedExtensionPage(connection, value)) return privateUrls ? privatePageUrl(value) : publicPageUrl(value);
    const url = new URL(value);
    return privateUrls ? url.href : `${url.protocol}//${url.host}${url.pathname}`;
  }
  async executeWorkflowStep(profileId: string, step: BrowserWorkflowStep, signal: AbortSignal): Promise<string | undefined> {
    const authorize = () => {
      if (signal.aborted) throw new Error("Workflow cancelled");
      if (!this.options.canControl(profileId)) throw new Error("Workflow requires an open manual or administrator profile");
    };
    authorize();
    if (step.kind === "navigate") {
      const url = browsingUrl(step.url), parsed = new URL(url);
      if (parsed.search || parsed.hash) throw new Error("Saved workflow addresses cannot contain queries or fragments");
      const state = await this.browserAction(profileId, { action: "navigate", url });
      authorize(); if (state.error) throw new Error("Workflow navigation could not finish"); return;
    }
    const connection = await this.connection(profileId), page = this.page(profileId, connection);
    await this.readyPage(profileId, connection, page);
    authorize(); this.assertAuthority(profileId, connection, page);
    if (connection.page !== page) throw new Error("Workflow browser page changed");
    const current = new URL(browsingUrl(page.url()));
    if (step.kind === "extract" && step.source === "url") { authorize(); return publicPageUrl(page.url()); }
    if (current.search || current.hash || /(?:^|\/)(?:login|signin|sign-in|signup|sign-up|register|auth|oauth|verify|2fa|mfa|captcha|challenge|wallet|cashier|payment|deposit|withdraw)(?:\/|$)/i.test(current.pathname)) throw new Error("Workflow extraction is unavailable on sensitive pages");
    if (step.kind === "scroll") {
      if (![step.deltaX, step.deltaY].every(value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 3000)) throw new Error("Workflow scroll exceeds its bounds");
      await bounded(page.mouse.wheel(step.deltaX, step.deltaY), 5000); authorize(); return;
    }
    if (step.kind !== "extract") throw new Error("Workflow step is unsupported");
    let result: string;
    if (step.source === "title") {
      result = (await bounded(page.title(), 5000)).slice(0, 4096);
      while (Buffer.byteLength(result) > 4096) result = result.slice(0, -1);
      if (sensitiveTargetPattern.test(result)) throw new Error("Sensitive page titles cannot be extracted");
    }
    else if (step.source === "text") {
      if (typeof step.selector !== "string" || !step.selector.length || step.selector.length > 512 || /[\x00-\x1f\x7f]/.test(step.selector)) throw new Error("Workflow text selector is invalid");
      try {
        result = await bounded(page.evaluate(({ selector, sensitive }) => {
          const nodes = document.querySelectorAll(selector);
          if (nodes.length !== 1) throw new Error("Choose exactly one public text element");
          const element = nodes[0]!;
          const controls = 'input,textarea,select,option,button,form,script,style,iframe,object,embed,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="spinbutton"],[hidden],[aria-hidden="true"]';
          if (element.closest(controls) || element.querySelector(controls)) throw new Error("Controls and hidden data cannot be extracted");
          const rule = new RegExp(sensitive, "i");
          for (let current: Element | null = element; current; current = current.parentElement) {
            const metadata = [current.id, current.getAttribute("name"), current.getAttribute("aria-label"), current.getAttribute("data-testid"), current.getAttribute("data-secret"), current.getAttribute("autocomplete")].filter(Boolean).join(" ");
            if (rule.test(metadata.replace(/([a-z])([A-Z])/g, "$1 $2")) || current.hasAttribute("data-secret")) throw new Error("Sensitive content cannot be extracted");
            const ancestorStyle = getComputedStyle(current);
            if (["hidden", "collapse"].includes(ancestorStyle.visibility) || ancestorStyle.display === "none" || ancestorStyle.opacity === "0" || ancestorStyle.contentVisibility === "hidden") throw new Error("Hidden content cannot be extracted");
          }
          const style = getComputedStyle(element);
          if (style.visibility === "hidden" || style.display === "none") throw new Error("Hidden content cannot be extracted");
          const descendants = element.querySelectorAll("*");
          if (descendants.length > 4096) throw new Error("Choose a smaller public text element");
          for (const child of descendants) {
            const childStyle = getComputedStyle(child);
            if (["hidden", "collapse"].includes(childStyle.visibility) || childStyle.display === "none" || childStyle.opacity === "0" || childStyle.contentVisibility === "hidden") throw new Error("Hidden descendants cannot be extracted");
          }
          const text = element.textContent ?? "";
          if (text.length > 65536 || new TextEncoder().encode(text).length > 65536 || rule.test(text)) throw new Error("Text is sensitive or exceeds its limit");
          return text;
        }, { selector: step.selector, sensitive: sensitiveTargetPattern.source }), 5000);
      } catch { throw new Error("Workflow text extraction requires one visible public text element without controls or sensitive data"); }
    } else throw new Error("Workflow extraction source is unsupported");
    authorize();
    if (this.connections.get(profileId) !== connection || connection.page !== page) throw new Error("Workflow browser page changed");
    return result;
  }
  async cookies(profileId: string, originValue: unknown): Promise<{ profileId: string; origin: string; cookies: import("./protocol.ts").SiteCookie[] }> {
    const origin = approvedOrigin(originValue);
    if (!this.options.canControl(profileId)) throw new Error("Switch this profile to manual control to manage its cookies");
    const connection = await this.connection(profileId);
    const cookies = await bounded(connection.context.cookies([origin]), 5000);
    if (!this.options.canControl(profileId) || this.connections.get(profileId) !== connection) throw new Error("This profile is no longer under direct operator control");
    if (cookies.length > 256 || Buffer.byteLength(JSON.stringify(cookies)) > 65536) throw new Error("This site's cookies exceed the 256-cookie or 64 KiB export limit");
    return { profileId, origin, cookies: cookies.map(({ name, value, domain, path, expires, httpOnly, secure, sameSite }) => ({ name, value, domain, path, expires, httpOnly, secure, sameSite })) };
  }
  async changeCookies(profileId: string, value: Record<string, unknown>): Promise<{ profileId: string; origin: string; changed: number }> {
    const origin = approvedOrigin(value.origin);
    if (!["import", "clear"].includes(String(value.action))) throw new Error("Cookie action must be import or clear");
    if (Object.keys(value).some(key => !["action", "origin", "cookies"].includes(key)) || (value.action === "clear" && value.cookies !== undefined)) throw new Error("Cookie request contains an unsupported field");
    if (!this.options.canControl(profileId)) throw new Error("Switch this profile to manual control to manage its cookies");
    const connection = await this.connection(profileId);
    const existing = await bounded(connection.context.cookies([origin]), 5000);
    if (this.connections.get(profileId) !== connection) throw new Error("Browser attachment changed before the cookie operation");
    const imported = value.action === "import" ? siteCookies(value.cookies, origin, existing.map(cookie => cookie.domain)) : [];
    if (!this.options.canControl(profileId)) throw new Error("This profile is no longer under direct operator control");
    this.options.beforeBrowserAction?.(profileId);
    try {
      if (value.action === "import") await bounded(connection.context.addCookies(imported), 5000);
      else {
        const domains = [...new Set(existing.map(cookie => cookie.domain))];
        for (const domain of domains) { this.assertAuthority(profileId, connection); await bounded(connection.context.clearCookies({ domain }), 5000); }
      }
    } catch { throw new Error("The cookie operation could not finish; check this profile and retry"); }
    return { profileId, origin, changed: value.action === "import" ? imported.length : existing.length };
  }
  async forgetProfile(profileId: string): Promise<void> {
    await this.detach(profileId);
    this.visible.delete(profileId); this.frameSequences.delete(profileId); this.suspended.delete(profileId);
  }
  private page(profileId: string, connection: Connection): Page {
    if (connection.page && !connection.page.isClosed()) return connection.page;
    const config = this.options.getConfig(profileId);
    const pages = connection.context.pages().filter(page => !page.isClosed());
    const page = pages.findLast(page => { try { return !!config?.origins.includes(new URL(page.url()).origin); } catch { return false; } }) ?? pages.at(-1);
    if (!page) throw new Error("Browser has no page");
    this.invalidateGeometry(connection); connection.page = page;
    return page;
  }
  private async frame(profileId: string): Promise<void> {
    let connection: Connection;
    try { connection = await this.connection(profileId); }
    catch { this.options.onError(profileId, "Browser live view is unavailable"); return; }
    if (connection.busy || !this.visible.has(profileId)) return;
    connection.busy = true;
    try {
      const page = this.page(profileId, connection);
      await this.readyPage(profileId, connection, page);
      this.assertReadAuthority(profileId, connection, page);
      if (connection.page !== page) return;
      const geometryEpoch = connection.geometryEpoch;
      const jpeg = await page.screenshot({ type: "jpeg", quality: 55, fullPage: false, scale: "css", timeout: 3000 });
      const dimensions = jpegDimensions(jpeg);
      this.assertReadAuthority(profileId, connection, page);
      if (connection.page !== page || connection.geometryEpoch !== geometryEpoch) return;
      connection.geometry = { page, ...dimensions, at: Date.now(), url: page.url() };
      if (this.visible.has(profileId) && this.connections.get(profileId) === connection) this.options.onFrame({ type: "FRAME", profileId, jpeg: jpeg.toString("base64"), ...dimensions, sequence: this.nextFrameSequence(profileId), at: Date.now(), url: this.pageUrl(connection, page.url(), false) });
    } catch { this.options.onError(profileId, "Browser frame could not be captured"); }
    finally { connection.busy = false; }
  }
  private invalidateGeometry(connection: Connection): void { connection.geometry = undefined; connection.geometryEpoch++; }
  private nextFrameSequence(profileId: string): number {
    const sequence = (this.frameSequences.get(profileId) ?? 0) + 1;
    this.frameSequences.set(profileId, sequence);
    return sequence;
  }
  async navigate(profileId: string, value: string): Promise<void> {
    await this.browserAction(profileId, { action: "navigate", url: value });
  }
  async control(input: ManualControl): Promise<void> {
    if (!this.options.canControl(input.profileId)) throw new Error("Choose the administrator profile or switch this profile to manual control");
    const connection = await this.connection(input.profileId);
    if (!this.options.canControl(input.profileId)) throw new Error("This profile is no longer under direct operator control");
    const page = this.page(input.profileId, connection);
    await this.readyPage(input.profileId, connection, page);
    const assertControl = () => {
      this.assertAuthority(input.profileId, connection, page);
      if (connection.page !== page) throw new Error("Browser page changed before manual input");
    };
    assertControl();
    if (!this.isTrustedExtensionPage(connection, page.url())) browsingUrl(page.url(), true);
    if (input.kind === "click") {
      let size = connection.geometry;
      if (!size || size.page !== page || size.url !== page.url() || Date.now() - size.at > 3000) {
        const geometryEpoch = connection.geometryEpoch;
        const jpeg = await page.screenshot({ type: "jpeg", quality: 55, fullPage: false, scale: "css", timeout: 3000 });
        if (connection.page !== page || connection.geometryEpoch !== geometryEpoch) throw new Error("Browser page changed before manual input");
        size = { page, ...jpegDimensions(jpeg), at: Date.now(), url: page.url() }; connection.geometry = size;
      }
      if (input.x! >= size.width || input.y! >= size.height) throw new Error("Click is outside the current browser viewport");
      assertControl();
      await page.mouse.click(input.x!, input.y!);
    } else if (input.kind === "scroll") await page.mouse.wheel(input.deltaX!, input.deltaY!);
    else if (input.kind === "key") await page.keyboard.press(input.key! === "Space" ? " " : input.key!);
    else await page.keyboard.insertText(input.text!);
  }
  async detach(profileId: string, suspend = true): Promise<void> {
    if (suspend) this.suspended.add(profileId);
    const connection = this.connections.get(profileId);
    if (!connection) return;
    this.cancelNavigations(connection);
    this.connections.delete(profileId);
    if (connection.stateTimer) clearTimeout(connection.stateTimer);
    try { connection.transport?.close(); } catch { /* A native stop may already have closed its page. */ }
    await disconnectBrowser(connection.browser);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    this.visible.clear();
    await Promise.allSettled([...this.connections.keys()].map(id => this.detach(id)));
    await Promise.allSettled(this.connecting.values());
    await Promise.allSettled([...this.connections.keys()].map(id => this.detach(id)));
  }
}
/** These Browser instances are attachments, never locally launched owners.
 * connectOverCDP shares the Playwright driver connection with other profiles:
 * closing _connection would invalidate every attachment using that driver.
 * Browser.close dispatches to this CDP attachment's transport-only close;
 * Firefox.connect closes only its dedicated remote client connection. */
async function disconnectBrowser(browser: Browser): Promise<void> {
  try { await browser.close(); } catch { /* Native teardown may already have closed this attachment. */ }
}
async function connectBrowser(launch: LaunchInfo): Promise<Browser> {
  (globalThis as any)[Symbol.for("aliasmode.playwrightFocusEmulation")] = false;
  const root = resolvePlaywrightRuntime().root;
  const runtime = await import(pathToFileURL(join(root, "node_modules", "playwright-core", "index.mjs")).href);
  if (launch.engine === "firefox") {
    if (!launch.firefoxOwner) throw new Error("Firefox owner is missing");
    const result = await callFirefoxOwner<{ endpoint: string }>(launch.firefoxOwner, "playwright-endpoint", {}, { timeoutMs: 15000 });
    return runtime.firefox.connect(result.endpoint, { timeout: 15000 });
  }
  return runtime.chromium.connectOverCDP(launch.ws, { timeout: 15000 });
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { const error = new Error("Browser operation timed out"); error.name = "TimeoutError"; reject(error); }, timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}

function privatePageUrl(value: string): string {
  if (value === "about:blank") return value;
  try { const url = new URL(value); url.username = ""; url.password = ""; return ["https:", "http:"].includes(url.protocol) ? url.href : ""; } catch { return ""; }
}
